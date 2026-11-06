import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { inboundMessages, organizations } from "@/lib/db/schema";
import { newMessageKey } from "@/lib/crypto";
import { newId } from "@/lib/ids";
import { newStorageKey, writeBody } from "@/lib/storage/bodies";
import { newInboundStorageKey } from "@/lib/inbound/attachments";
import { recordEvent } from "@/lib/messages/events";
import { readMessage, readMessageWithBody } from "@/lib/dashboard/messages";
import { GET as listEmails } from "@/app/api/v1/emails/route";
import { GET as readEmail } from "@/app/api/v1/emails/[id]/route";
import { GET as listInbound } from "@/app/api/v1/inbound/route";
import { GET as readInbound } from "@/app/api/v1/inbound/[id]/route";
import { GET as download } from "@/app/download/[token]/route";
import { POST as mcp } from "@/app/mcp/route";
import { resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

const DAY = 24 * 60 * 60 * 1000;
const PDF = Buffer.from("%PDF-1.7 fake invoice");

const BASE_KEYS = [
  "id",
  "url",
  "status",
  "from",
  "to",
  "cc",
  "bcc",
  "reply_to",
  "subject",
  "tags",
  "headers",
  "layout",
  "key_id",
  "batch_id",
  "test_mode",
  "sensitive",
  "warnings",
  "provider_message_id",
  "reason",
  "attempts",
  "next_attempt_at",
  "created_at",
  "sent_at",
  "delivered_at",
  "abandoned_at",
  "size",
  "resent_from",
];

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture({ scopeToDomain: false });
});

function get(path: string): Request {
  return new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${fixture.secret}` } });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** A delivered message with a stored body and one attachment. */
async function messageWithBody(overrides: { createdAt?: Date } = {}): Promise<string> {
  const storageKey = newStorageKey();
  const { key, encoded } = newMessageKey();
  await writeBody(key, storageKey, {
    html: "<p>Your invoice.</p>",
    text: "Your invoice.",
    textGenerated: false,
    attachments: [{ filename: "invoice.pdf", content: PDF.toString("base64"), contentType: "application/pdf" }],
  });
  const id = await seedMessage(fixture, { storageKey, bodyKey: encoded, apiKeyId: fixture.key.id, ...overrides });
  await recordEvent({ organizationId: fixture.organizationId, messageId: id, status: "queued", occurredAt: new Date(Date.now() - 2000) });
  await recordEvent({ organizationId: fixture.organizationId, messageId: id, status: "delivered", occurredAt: new Date(Date.now() - 1000) });
  return id;
}

describe("GET /v1/emails/:id", () => {
  it("keeps today's default: events, stall and resends, no body", async () => {
    const id = await messageWithBody();
    const body = (await (await readEmail(get(`/v1/emails/${id}`), params(id))).json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([...BASE_KEYS, "events", "stall", "resends"]);
    expect((body.events as { status: string }[]).map((event) => event.status)).toEqual(["queued", "delivered"]);
  });

  it("adds the body with include=body, and its attachment link downloads the file", async () => {
    const id = await messageWithBody();
    const body = (await (await readEmail(get(`/v1/emails/${id}?include=body`), params(id))).json()) as {
      body: { html: string; text: string; attachments: { filename: string; size: number; download_url: string }[] };
      body_unavailable: unknown;
    };
    expect(body.body).toMatchObject({ html: "<p>Your invoice.</p>", text: "Your invoice." });
    expect(body.body_unavailable).toBeNull();
    expect(body.body.attachments).toMatchObject([{ filename: "invoice.pdf", content_type: "application/pdf", size: PDF.length }]);

    const token = new URL(body.body.attachments[0]!.download_url).pathname.split("/").pop()!;
    const file = await download(new Request(`http://localhost/download/${token}`), { params: Promise.resolve({ token }) });
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(PDF)).toBe(true);
  });

  it("says why the body is gone past retention, and its link stops working", async () => {
    const old = await messageWithBody({ createdAt: new Date(Date.now() - 8 * DAY) });
    const readable = (await (await readEmail(get(`/v1/emails/${old}?include=body`), params(old))).json()) as {
      body: { attachments: { download_url: string }[] };
    };
    const token = new URL(readable.body.attachments[0]!.download_url).pathname.split("/").pop()!;

    await db.update(organizations).set({ bodyRetentionDays: 7 }).where(eq(organizations.id, fixture.organizationId));
    const body = (await (await readEmail(get(`/v1/emails/${old}?include=body`), params(old))).json()) as Record<string, unknown>;
    expect(body.body).toBeNull();
    expect(body.body_unavailable).toMatchObject({ reason: "expired" });
    expect((await download(new Request("http://localhost"), { params: Promise.resolve({ token }) })).status).toBe(404);
  });

  it("returns only id and the named fields, without loading the defaults' expansions", async () => {
    const id = await messageWithBody();
    const body = (await (await readEmail(get(`/v1/emails/${id}?fields=status,subject`), params(id))).json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["id", "status", "subject"]);
  });

  it("refuses an unknown include with validation_failed naming the valid values", async () => {
    const id = await messageWithBody();
    const response = await readEmail(get(`/v1/emails/${id}?include=facts`), params(id));
    expect(response.status).toBe(422);
    const { error } = (await response.json()) as { error: { code: string; field: string; detail: { valid: string[] } } };
    expect(error).toMatchObject({ code: "validation_failed", field: "include" });
    expect(error.detail.valid).toEqual(["events", "occurrences", "stall", "body", "rendered", "resends"]);
  });
});

describe("GET /v1/emails", () => {
  it("leaves events and bodies out by default and adds them on request", async () => {
    const id = await messageWithBody();

    const plain = (await (await listEmails(get("/v1/emails"))).json()) as { data: Record<string, unknown>[] };
    expect(Object.keys(plain.data[0]!)).toEqual(BASE_KEYS);

    const expanded = (await (await listEmails(get("/v1/emails?include=events,body&fields=subject"))).json()) as {
      data: { id: string; events: { status: string }[]; body: { text: string } }[];
    };
    expect(Object.keys(expanded.data[0]!)).toEqual(["id", "subject", "events", "body", "body_unavailable"]);
    expect(expanded.data[0]!.id).toBe(id);
    expect(expanded.data[0]!.events.map((event) => event.status)).toEqual(["queued", "delivered"]);
    expect(expanded.data[0]!.body.text).toBe("Your invoice.");
  });

  it("refuses stall, which only the single read carries", async () => {
    const response = await listEmails(get("/v1/emails?include=stall"));
    expect(response.status).toBe(422);
  });
});

describe("inbound", () => {
  /** A sealed row whose body object was never written: reading the body fails. */
  async function inboundWithoutBodyObject(): Promise<string> {
    const id = newId("inbound");
    await db.insert(inboundMessages).values({
      id,
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      fromAddress: "ada@example.net",
      to: ["reply@inbound.example.com"],
      subject: "Plans",
      attachments: [],
      storageKey: newInboundStorageKey(),
      bodyKey: newMessageKey().encoded,
      threadId: newId("thread"),
      receivedAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * DAY),
    });
    return id;
  }

  it("skips the storage read when fields leaves the body out", async () => {
    const id = await inboundWithoutBodyObject();

    const full = await listInbound(get("/v1/inbound"));
    expect(full.status).toBeGreaterThanOrEqual(500);

    const page = (await (await listInbound(get("/v1/inbound?fields=from,subject"))).json()) as { data: Record<string, unknown>[] };
    expect(page.data).toEqual([{ id, from: "ada@example.net", subject: "Plans" }]);

    const one = (await (await readInbound(get(`/v1/inbound/${id}?fields=subject`), params(id))).json()) as Record<string, unknown>;
    expect(one).toEqual({ id, subject: "Plans" });
  });

  it("refuses an unknown field", async () => {
    const response = await listInbound(get("/v1/inbound?fields=bodies"));
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { field: string } }).error.field).toBe("fields");
  });
});

describe("the dashboard's JSON tab", () => {
  it("shows exactly what the API returns for each request", async () => {
    const id = await messageWithBody();
    const detail = await readMessage(fixture.organizationId, id);
    const plain = await (await readEmail(get(`/v1/emails/${id}`), params(id))).json();
    expect(JSON.parse(detail!.api.plain.response)).toEqual(plain);
    expect(detail!.api.plain.requests[0]!.code).toContain(`/v1/emails/${id}'`);
    expect(detail!.api.plain.requests[1]!.code).toContain(`pouch.emails.get("${id}")`);
    expect(detail!.api.withBodyRequests[0]!.code).toContain(`/v1/emails/${id}?include=body'`);
    expect(detail!.api.withBodyRequests[1]!.code).toContain('include: ["body"]');
    expect(detail!.api.plain.response).not.toContain("download_url");

    const lazy = await readMessageWithBody(fixture.organizationId, id);
    expect(lazy!.request).toBe(detail!.api.withBodyRequests[0]!.code);
    const withBody = (await (await readEmail(get(`/v1/emails/${id}?include=body`), params(id))).json()) as { body: { attachments: { download_url?: string }[] } };
    const shown = JSON.parse(lazy!.response) as typeof withBody;
    // Download links are minted per read, so only their presence is compared.
    for (const value of [withBody, shown]) for (const attachment of value.body.attachments) delete attachment.download_url;
    expect(shown).toEqual(withBody);
  });
});

describe("MCP", () => {
  it("passes include and fields through read_email as arrays", async () => {
    const id = await messageWithBody();
    const response = await mcp(
      new Request("http://mcp.test/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${fixture.secret}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "read_email", arguments: { id, include: ["body"], fields: ["status"] } },
        }),
      }),
    );
    const result = ((await response.json()) as { result: { isError: boolean; structuredContent: Record<string, unknown> } }).result;
    expect(result.isError).toBe(false);
    expect(Object.keys(result.structuredContent)).toEqual(["id", "status", "body", "body_unavailable"]);
  });
});
