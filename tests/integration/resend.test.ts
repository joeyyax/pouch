import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { domainUnsubscribes, messages } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { idle } from "@/lib/dashboard/action-state";
import { acceptMessage } from "@/lib/messages/create";
import { readBody } from "@/lib/storage/bodies";
import { addSuppression, apiRequest, messageRow, resetDatabase, routeContext, seedFixture, type Fixture } from "./fixtures";

const sessionState = vi.hoisted(() => ({ organizationId: "" }));

vi.mock("@/lib/dashboard/session", async (importOriginal) =>
  (await import("./fixtures")).dashboardSessionModule(await importOriginal<typeof import("@/lib/dashboard/session")>(), sessionState),
);
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { POST: resendRoute } = await import("@/app/api/v1/emails/[id]/resend/route");
const { GET: readRoute } = await import("@/app/api/v1/emails/[id]/route");
const { resendMessageAction } = await import("@/app/(app)/messages/actions");
const { readMessage } = await import("@/lib/dashboard/messages");

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture({ scopeToDomain: false });
  sessionState.organizationId = fixture.organizationId;
});

const ORIGINAL = {
  from: "Ada <ada@example.com>",
  to: ["person@example.net"],
  cc: ["copy@example.net"],
  reply_to: ["replies@example.com"],
  subject: "Your receipt",
  html: "<p>Thanks</p>",
  text: "Thanks",
  headers: { "x-order": "1234" },
  tags: ["receipt"],
  attachments: [{ filename: "receipt.txt", content: "aGVsbG8=", content_type: "text/plain" }],
};

async function original(): Promise<string> {
  const { message } = await acceptMessage(fixture.key, ORIGINAL, null);
  return message.id;
}

function resend(id: string, options: { secret?: string; idempotencyKey?: string } = {}) {
  const request = apiRequest(options.secret ?? fixture.secret, `/v1/emails/${id}/resend`, "POST");
  if (options.idempotencyKey) request.headers.set("idempotency-key", options.idempotencyKey);
  return resendRoute(request, routeContext(id));
}

async function errorOf(response: Response) {
  return ((await response.json()) as { error: { code: string; message: string; detail?: Record<string, unknown> } }).error;
}

describe("POST /v1/emails/:id/resend", () => {
  it("queues a new message with the original's send, linked to it", async () => {
    const id = await original();

    const response = await resend(id);
    expect(response.status).toBe(202);
    const copy = (await response.json()) as Record<string, unknown>;
    expect(copy.id).not.toBe(id);
    expect(response.headers.get("location")).toContain(`/v1/emails/${copy.id as string}`);
    expect(copy).toMatchObject({
      status: "queued",
      from: "Ada <ada@example.com>",
      to: ["person@example.net"],
      cc: ["copy@example.net"],
      reply_to: ["replies@example.com"],
      subject: "Your receipt",
      headers: { "x-order": "1234" },
      tags: ["receipt"],
      key_id: fixture.key.id,
      resent_from: id,
      size: { body_bytes: 19, attachment_bytes: 5 },
    });

    const row = await messageRow(copy.id as string);
    const body = await readBody(Buffer.from(row.bodyKey!, "base64"), row.storageKey!);
    expect(body).toMatchObject({ html: "<p>Thanks</p>", text: "Thanks" });
    expect(body.attachments).toEqual([{ filename: "receipt.txt", content: "aGVsbG8=", contentType: "text/plain" }]);
    expect(row.storageKey).not.toBe((await messageRow(id)).storageKey);
  });

  it("lists the copies on the original and names the original on the copy", async () => {
    const id = await original();
    const first = (await (await resend(id)).json()) as { id: string };
    const second = (await (await resend(id)).json()) as { id: string };

    const read = await readRoute(apiRequest(fixture.secret, `/v1/emails/${id}`), routeContext(id));
    const parsed = (await read.json()) as { resent_from: string | null; resends: { id: string; status: string }[] };
    expect(parsed.resent_from).toBeNull();
    expect(parsed.resends.map((copy) => copy.id)).toEqual([first.id, second.id]);
    expect(parsed.resends[0]).toMatchObject({ status: "queued" });

    const copy = await readRoute(apiRequest(fixture.secret, `/v1/emails/${first.id}`), routeContext(first.id));
    expect(await copy.json()).toMatchObject({ resent_from: id, resends: [] });
  });

  it("replays an Idempotency-Key and refuses it for another message", async () => {
    const id = await original();
    const other = await original();

    const first = (await (await resend(id, { idempotencyKey: "resend-1" })).json()) as { id: string };
    const again = await resend(id, { idempotencyKey: "resend-1" });
    expect(again.status).toBe(202);
    expect(((await again.json()) as { id: string }).id).toBe(first.id);
    expect(await db.select({ id: messages.id }).from(messages).where(eq(messages.resentFrom, id))).toHaveLength(1);

    const conflict = await resend(other, { idempotencyKey: "resend-1" });
    expect(conflict.status).toBe(409);
    expect(await errorOf(conflict)).toMatchObject({ code: "idempotency_conflict", detail: { message_id: first.id } });
  });

  it("replays even after the original's body is gone", async () => {
    const id = await original();
    const first = (await (await resend(id, { idempotencyKey: "resend-2" })).json()) as { id: string };
    await db.update(messages).set({ bodyKey: null, bodyPurgedAt: new Date() }).where(eq(messages.id, id));

    const again = await resend(id, { idempotencyKey: "resend-2" });
    expect(again.status).toBe(202);
    expect(((await again.json()) as { id: string }).id).toBe(first.id);
  });

  it("refuses a recipient suppressed since the original", async () => {
    const id = await original();
    await addSuppression(fixture.organizationId, "copy@example.net");

    const response = await resend(id);
    expect(response.status).toBe(422);
    expect(await errorOf(response)).toMatchObject({ code: "recipient_suppressed", detail: { address: "copy@example.net" } });
  });

  it("refuses a bulk original whose recipient unsubscribed from the domain since, and resends a plain one", async () => {
    const bulk = await original();
    const plain = await original();
    await db.update(messages).set({ batchId: newId("batch") }).where(eq(messages.id, bulk));
    await db.insert(domainUnsubscribes).values({
      id: newId("domainUnsubscribe"),
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      address: "person@example.net",
    });

    const refused = await resend(bulk);
    expect(refused.status).toBe(422);
    expect(await errorOf(refused)).toMatchObject({ code: "resend_not_allowed", detail: { reason: "unsubscribed" } });
    expect((await resend(plain)).status).toBe(202);
  });

  it("reads another organization's message as not found", async () => {
    const id = await original();
    const other = await seedFixture();

    const response = await resend(id, { secret: other.secret });
    expect(response.status).toBe(404);
    expect(await errorOf(response)).toMatchObject({ code: "not_found" });
  });

  describe("when the body can't be read", () => {
    it("refuses a withheld body with its reason", async () => {
      const id = await original();
      await db.update(messages).set({ bodyWithheld: "a sign-in link" }).where(eq(messages.id, id));

      const response = await resend(id);
      expect(response.status).toBe(422);
      expect(await errorOf(response)).toEqual({
        code: "resend_not_allowed",
        message: "This message can't be resent. It was marked as sensitive because it contained a sign-in link.",
        detail: { reason: "withheld", ended_at: null },
        request_id: expect.any(String),
      });
    });

    it("refuses a withheld body with an empty reason", async () => {
      const id = await original();
      await db.update(messages).set({ bodyWithheld: "" }).where(eq(messages.id, id));

      const response = await resend(id);
      expect(response.status).toBe(422);
      expect(await errorOf(response)).toMatchObject({
        code: "resend_not_allowed",
        message: "This message can't be resent. It was marked as sensitive.",
        detail: { reason: "withheld" },
      });

      const read = await readRoute(apiRequest(fixture.secret, `/v1/emails/${id}?include=body`), routeContext(id));
      expect(await read.json()).toMatchObject({
        body: null,
        body_unavailable: { reason: "withheld", message: "Body withheld: it was marked as sensitive." },
      });
    });

    it("refuses a shredded body", async () => {
      const id = await original();
      const purgedAt = new Date("2026-09-01T00:00:00Z");
      await db.update(messages).set({ bodyKey: null, bodyPurgedAt: purgedAt }).where(eq(messages.id, id));

      const response = await resend(id);
      expect(response.status).toBe(422);
      expect(await errorOf(response)).toMatchObject({
        code: "resend_not_allowed",
        detail: { reason: "shredded", ended_at: purgedAt.toISOString() },
      });
    });

    it("refuses a body past retention", async () => {
      const id = await original();
      await db.update(messages).set({ createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) }).where(eq(messages.id, id));

      const response = await resend(id);
      expect(response.status).toBe(422);
      expect(await errorOf(response)).toMatchObject({ code: "resend_not_allowed", detail: { reason: "expired" } });
    });

    it("answers 503 when storage doesn't", async () => {
      const id = await original();
      await db.update(messages).set({ storageKey: "bodies/missing-object" }).where(eq(messages.id, id));

      const response = await resend(id);
      expect(response.status).toBe(503);
      expect(await errorOf(response)).toMatchObject({ code: "storage_unavailable" });
    });
  });
});

describe("resendMessageAction", () => {
  it("resends from the dashboard with no key and links to the copy", async () => {
    const id = await original();
    const data = new FormData();
    data.set("messageId", id);

    const state = await resendMessageAction(idle, data);
    expect(state).toMatchObject({ status: "ok", message: "Message resent." });
    const href = (state as { href: string }).href;
    const copyId = href.replace("/messages/", "");
    const copy = await messageRow(copyId);
    expect(copy).toMatchObject({ resentFrom: id, apiKeyId: null, testMode: false });

    const detail = await readMessage(fixture.organizationId, id);
    expect(detail?.resends.map((entry) => entry.id)).toEqual([copyId]);
    expect(detail?.resendBlocked).toBeNull();
    expect((await readMessage(fixture.organizationId, copyId))?.resentFrom).toBe(id);
  });

  it("names why Resend is off for a withheld body", async () => {
    const id = await original();
    await db.update(messages).set({ bodyWithheld: "a password reset link" }).where(eq(messages.id, id));

    const detail = await readMessage(fixture.organizationId, id);
    expect(detail?.resendBlocked).toBe("This message can't be resent. It was marked as sensitive because it contained a password reset link.");
  });

  it("can't reach another organization's message", async () => {
    const id = await original();
    sessionState.organizationId = (await seedFixture()).organizationId;
    const data = new FormData();
    data.set("messageId", id);

    expect(await resendMessageAction(idle, data)).toMatchObject({ status: "error", message: `No message with id ${id}.` });
  });
});
