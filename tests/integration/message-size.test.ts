import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages } from "@/lib/db/schema";
import { acceptMessage } from "@/lib/messages/create";
import { createBatch } from "@/lib/bulk/create";
import { setBulkAllowed } from "@/lib/domains";
import { apiKeyActor } from "@/lib/activity/record";
import { readBody } from "@/lib/storage/bodies";
import { GET as readEmail } from "@/app/api/v1/emails/[id]/route";
import { resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture({ scopeToDomain: false });
});

async function row(id: string) {
  const [found] = await db.select().from(messages).where(eq(messages.id, id));
  return found!;
}

async function apiSize(id: string) {
  const response = await readEmail(
    new Request(`http://localhost/v1/emails/${id}`, { headers: { authorization: `Bearer ${fixture.secret}` } }),
    { params: Promise.resolve({ id }) },
  );
  return ((await response.json()) as { size: unknown }).size;
}

const send = { from: "Ada <ada@example.com>", to: ["person@example.net"], subject: "Hello" };

describe("message sizes at accept", () => {
  it("a single send records the body and attachment bytes, and the API reads them back", async () => {
    const { message } = await acceptMessage(
      fixture.key,
      { ...send, html: "<p>Hi</p>", text: "Hi", attachments: [{ filename: "a.txt", content: "aGVsbG8=", content_type: "text/plain" }] },
      null,
    );

    const stored = await row(message.id);
    expect(stored.bodyBytes).toBe(11);
    expect(stored.attachmentBytes).toBe(5);
    expect(await apiSize(message.id)).toEqual({ body_bytes: 11, attachment_bytes: 5 });
  });

  it("multibyte UTF-8 counts bytes, not characters", async () => {
    const html = "<p>héllo ✓ 日本</p>";
    expect([...html]).toHaveLength(17);

    const { message } = await acceptMessage(fixture.key, { ...send, html, text: "" }, null);

    expect((await row(message.id)).bodyBytes).toBe(24);
  });

  it("a message with no attachments records 0, not null", async () => {
    const { message } = await acceptMessage(fixture.key, { ...send, html: "<p>Hi</p>", text: "Hi" }, null);

    expect((await row(message.id)).attachmentBytes).toBe(0);
    expect(await apiSize(message.id)).toMatchObject({ attachment_bytes: 0 });
  });

  it("counts a text part generated from the html, since that's what's stored and sent", async () => {
    const { message } = await acceptMessage(fixture.key, { ...send, html: "<p>Hi there</p>" }, null);

    const stored = await row(message.id);
    const body = await readBody(Buffer.from(stored.bodyKey!, "base64"), stored.storageKey!);
    expect(body.text).toBeTruthy();
    expect(stored.bodyBytes).toBe(Buffer.byteLength("<p>Hi there</p>") + Buffer.byteLength(body.text!));
  });

  it("a batch records each recipient's own rendered size", async () => {
    await setBulkAllowed(
      { organizationId: fixture.organizationId, domainIds: [fixture.domainId], actor: apiKeyActor(fixture.key.id, fixture.key.name) },
      fixture.domainId,
      true,
    );

    const batch = await createBatch(
      { organizationId: fixture.organizationId, domainIds: [fixture.domainId], apiKeyId: fixture.key.id, mode: "live" },
      {
        from: "Ada <ada@example.com>",
        subject: "Notice",
        html: "<p>Hi {{name}}.</p>",
        text: "Hi {{name}}",
        recipients: [
          { address: "zoe@example.net", attributes: { name: "Zoë" } },
          { address: "al@example.net", attributes: { name: "Al" } },
        ],
      },
    );

    const rows = await db.select().from(messages).where(eq(messages.batchId, batch.id));
    const bySize = Object.fromEntries(rows.map((r) => [r.recipients[0], [r.bodyBytes, r.attachmentBytes]]));
    // "<p>Hi Zoë.</p>" is 15 bytes in 14 characters; "Hi Zoë" is 7.
    expect(bySize["zoe@example.net"]).toEqual([22, 0]);
    expect(bySize["al@example.net"]).toEqual([18, 0]);
  });

  it("a message accepted before sizes were recorded reads null, never 0", async () => {
    const id = await seedMessage(fixture);

    expect(await apiSize(id)).toEqual({ body_bytes: null, attachment_bytes: null });
  });
});
