import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, messageEvents, messages } from "@/lib/db/schema";
import type { MessageStatus } from "@/lib/db/schema";
import { newMessageKey } from "@/lib/crypto";
import { newId } from "@/lib/ids";
import { newStorageKey, writeBody } from "@/lib/storage/bodies";
import { csvField, csvRow } from "@/lib/exports/csv";
import { countExportableMessages, iterateExportMessages } from "@/lib/exports/messages-query";
import { messagesCsvLines, messagesNdjsonLines } from "@/lib/exports/log";
import { countOrganizationData, organizationDataNdjsonLines } from "@/lib/exports/data";
import { loadExportBody, buildMessageEml } from "@/lib/exports/eml";
import { bodiesZipChunks } from "@/lib/exports/bodies";
import { crc32, ZipWriter } from "@/lib/exports/zip";
import { recordExport } from "@/lib/exports/audit";
import { userActor } from "@/lib/activity/record";
import { addSuppression, resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

const DAY = 24 * 60 * 60 * 1000;

interface InsertOptions {
  organizationId: string;
  domainId: string;
  status?: MessageStatus;
  subject?: string;
  tags?: string[];
  createdAt?: Date;
  storageKey?: string | null;
  bodyKey?: string | null;
  bodyPurgedAt?: Date | null;
  attachmentCount?: number;
}

async function insertMessage({ organizationId, domainId, ...rest }: InsertOptions): Promise<string> {
  return seedMessage({ organizationId, domainId }, { fromName: "Scope", ...rest });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of gen) out.push(value);
  return out;
}

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

describe("csv escaping", () => {
  it("quotes only when the field needs it", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("has,comma")).toBe('"has,comma"');
    expect(csvField('has "quote"')).toBe('"has ""quote"""');
    expect(csvField(null)).toBe("");
  });

  it("terminates a row with CRLF, per RFC 4180", () => {
    expect(csvRow(["a", "b"])).toBe("a,b\r\n");
  });
});

describe("the exportable message query", () => {
  it("matches the messages screen's own filters", async () => {
    const matching = await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      status: "bounced",
      tags: ["receipt"],
    });
    await insertMessage({ organizationId: fixture.organizationId, domainId: fixture.domainId, status: "delivered" });

    const count = await countExportableMessages(fixture.organizationId, { statuses: ["bounced"] });
    expect(count).toBe(1);

    const rows = await collect(iterateExportMessages(fixture.organizationId, { statuses: ["bounced"] }));
    expect(rows.map((row) => row.message.id)).toEqual([matching]);
  });

  it("never crosses into another organization", async () => {
    await insertMessage({ organizationId: fixture.organizationId, domainId: fixture.domainId });
    const other = await seedFixture();
    await insertMessage({ organizationId: other.organizationId, domainId: other.domainId });

    const rows = await collect(iterateExportMessages(fixture.organizationId, {}));
    expect(rows).toHaveLength(1);
  });

  it("pages a cursor across a page boundary without skipping or repeating a row", async () => {
    // Real risk of a (created_at desc) cursor with no tiebreak: same-millisecond rows can
    // fall on either side of a page boundary and vanish or double up. One batch over
    // EXPORT_BATCH_SIZE, all sharing one timestamp, forces at least one such boundary.
    const { EXPORT_BATCH_SIZE } = await import("@/lib/exports/limits");
    const stamp = new Date("2026-01-01T00:00:00.000Z");
    const total = EXPORT_BATCH_SIZE + 5;
    const ids = Array.from({ length: total }, () => newId("message"));
    await db.insert(messages).values(
      ids.map((id) => ({
        id,
        organizationId: fixture.organizationId,
        domainId: fixture.domainId,
        status: "delivered" as const,
        fromAddress: "hi@example.com",
        recipients: ["name@example.com"],
        subject: "Your invite",
        envelope: {
          from: "hi@example.com",
          fromName: "Scope",
          to: ["name@example.com"],
          cc: [],
          bcc: [],
          replyTo: [],
          headers: {},
          attachmentCount: 0,
        },
        createdAt: stamp,
        updatedAt: stamp,
      })),
    );

    const rows = await collect(iterateExportMessages(fixture.organizationId, {}));
    const seen = rows.map((row) => row.message.id);
    expect(new Set(seen).size).toBe(total);
    expect(seen.sort()).toEqual([...ids].sort());
  });
});

describe("the CSV log", () => {
  it("carries only the filtered rows, and the fields the brief names", async () => {
    const id = await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      status: "failed",
      subject: "Receipt, #4821",
    });
    await db.update(messages).set({ failureReason: "Mailbox full" }).where(eq(messages.id, id));
    const excluded = await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      status: "delivered",
    });

    const lines = (await collect(messagesCsvLines(fixture.organizationId, { statuses: ["failed"] }))).join("");
    expect(lines).toContain(id);
    expect(lines).toContain('"Receipt, #4821"');
    expect(lines).toContain("Mailbox full");
    expect(lines.split("\r\n")[0]).toBe("id,status,from,to,cc,bcc,subject,tags,domain,test_mode,provider_message_id,failure_reason,attempts,created_at,sent_at,delivered_at");
    expect(lines).not.toContain(excluded);
  });
});

describe("the NDJSON log", () => {
  it("nests the full event history, not just transitions", async () => {
    const id = await insertMessage({ organizationId: fixture.organizationId, domainId: fixture.domainId, status: "delivered" });
    await db.insert(messageEvents).values([
      {
        id: newId("event"),
        organizationId: fixture.organizationId,
        messageId: id,
        kind: "transition",
        status: "delivered",
        occurredAt: new Date(),
      },
      {
        id: newId("event"),
        organizationId: fixture.organizationId,
        messageId: id,
        kind: "body_shredded",
        status: null,
        detail: { retentionDays: 45 },
        occurredAt: new Date(),
      },
    ]);

    const [line] = await collect(messagesNdjsonLines(fixture.organizationId, {}));
    const parsed = JSON.parse(line!.trim());
    expect(parsed.type).toBe("message");
    expect(parsed.id).toBe(id);
    const kinds = parsed.events.map((event: { kind: string }) => event.kind);
    expect(kinds).toEqual(expect.arrayContaining(["transition", "body_shredded"]));
  });
});

describe("organization data (suppressions and domains)", () => {
  it("counts and emits both tables", async () => {
    await addSuppression(fixture.organizationId, "bounced@example.com");

    expect(await countOrganizationData(fixture.organizationId)).toBe(2); // 1 suppression + 1 domain

    const lines = await collect(organizationDataNdjsonLines(fixture.organizationId));
    const types = lines.map((line) => JSON.parse(line).type);
    expect(types).toContain("suppression");
    expect(types).toContain("domain");

    const domainLine = lines.map((line) => JSON.parse(line)).find((row) => row.type === "domain");
    expect(domainLine.name).toBe("example.com");
  });
});

describe("bodies — the part the encryption makes interesting", () => {
  it("reports an available body inside its retention window", async () => {
    const storageKey = newStorageKey();
    const { key, encoded } = newMessageKey();
    await writeBody(key, storageKey, {
      html: "<p>hello there</p>",
      text: "hello there",
      textGenerated: false,
      attachments: [{ filename: "receipt.txt", content: Buffer.from("total: $12").toString("base64"), contentType: "text/plain" }],
    });

    const [row] = await db
      .select()
      .from(messages)
      .where(
        eq(
          messages.id,
          await insertMessage({
            organizationId: fixture.organizationId,
            domainId: fixture.domainId,
            storageKey,
            bodyKey: encoded,
          }),
        ),
      );

    const body = await loadExportBody(row!, 45);
    expect(body.status).toBe("available");
    expect(body.html).toContain("hello there");
    expect(body.attachments).toHaveLength(1);

    const eml = buildMessageEml(row!, "example.com", body);
    expect(eml).toContain("X-Pouch-Body-Status: available");
    // The attachment survives the round trip through MIME, base64 and all.
    expect(eml).toContain(Buffer.from("total: $12").toString("base64"));
  });

  it("says a shredded body is gone, and carries no trace of what it used to say", async () => {
    // Simulates exactly what the retention sweep does: writes a real body, then nulls the
    // key and stamps the purge date, the same as worker/retention.ts's shred().
    const storageKey = newStorageKey();
    const { key } = newMessageKey();
    await writeBody(key, storageKey, {
      html: "<p>a secret only the recipient should ever read</p>",
      text: "a secret only the recipient should ever read",
      textGenerated: false,
      attachments: [],
    });

    const id = await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      storageKey,
      bodyKey: null,
      bodyPurgedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const [row] = await db.select().from(messages).where(eq(messages.id, id));

    const body = await loadExportBody(row!, 45);
    expect(body.status).toBe("shredded");
    expect(body.reason).toContain("2026-01-01");
    expect(body.html).toBeNull();

    const eml = buildMessageEml(row!, "example.com", body);
    expect(eml).toContain("X-Pouch-Body-Status: shredded");
    // The whole point of #45: a blank field would be indistinguishable from a bug. This
    // asserts the export never falls back to reading the still-live object in storage —
    // the row's key is gone, so the export must not have a way to say otherwise.
    expect(eml).not.toContain("a secret only the recipient should ever read");
  });

  it("reports a body past retention even before the sweep has run", async () => {
    const oldCreatedAt = new Date(Date.now() - 100 * DAY);
    const id = await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      storageKey: newStorageKey(),
      bodyKey: newMessageKey().encoded,
      createdAt: oldCreatedAt,
    });
    const [row] = await db.select().from(messages).where(eq(messages.id, id));

    const body = await loadExportBody(row!, 45);
    expect(body.status).toBe("expired");
  });

  it("reports unavailable when storage can't answer, distinct from a retention gap", async () => {
    const id = await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      storageKey: "no-such-object",
      bodyKey: newMessageKey().encoded,
    });
    const [row] = await db.select().from(messages).where(eq(messages.id, id));

    const body = await loadExportBody(row!, 45);
    expect(body.status).toBe("unavailable");
  });

  it("bundles one .eml per message into a zip that round-trips byte for byte", async () => {
    const storageKey = newStorageKey();
    const { key, encoded } = newMessageKey();
    await writeBody(key, storageKey, { html: "<p>hi</p>", text: "hi", textGenerated: false, attachments: [] });

    await insertMessage({ organizationId: fixture.organizationId, domainId: fixture.domainId, storageKey, bodyKey: encoded });
    await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      bodyKey: null,
      bodyPurgedAt: new Date(),
    });

    const chunks = await collect(bodiesZipChunks(fixture.organizationId, {}));
    const archive = Buffer.concat(chunks);

    const entries = readZipEntries(archive);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(crc32(entry.content)).toBe(entry.crc);
      expect(entry.name.endsWith(".eml")).toBe(true);
    }
    const statuses = entries.map((entry) => entry.content.toString("utf8"));
    expect(statuses.some((text) => text.includes("X-Pouch-Body-Status: available"))).toBe(true);
    expect(statuses.some((text) => text.includes("X-Pouch-Body-Status: shredded"))).toBe(true);
  });
});

describe("every export is audit-recorded", () => {
  it("writes who, when, what and how many, best-effort", async () => {
    await recordExport({
      organizationId: fixture.organizationId,
      actor: userActor("u_test", "Test"),
      kind: "log_csv",
      filters: { domain: "example.com" },
      count: 3,
    });

    const [row] = await db.select().from(activity).where(eq(activity.organizationId, fixture.organizationId));
    expect(row?.action).toBe("system.export.created");
    expect(row?.actorType).toBe("user");
    expect(row?.metadata).toMatchObject({ kind: "log_csv", count: 3, domain: "example.com" });
  });
});

describe("ZipWriter", () => {
  it("writes entries a real reader can parse back out", () => {
    const zip = new ZipWriter();
    const chunks: Buffer[] = [];
    chunks.push(zip.addFile("a.txt", Buffer.from("first")));
    chunks.push(zip.addFile("b.txt", Buffer.from("second, longer")));
    chunks.push(zip.finish());

    const entries = readZipEntries(Buffer.concat(chunks));
    expect(entries.map((entry) => entry.name)).toEqual(["a.txt", "b.txt"]);
    expect(entries[0]!.content.toString()).toBe("first");
    expect(entries[1]!.content.toString()).toBe("second, longer");
  });
});

/** Minimal STORE-only ZIP reader: reads local file headers sequentially, as ZipWriter writes them. */
function readZipEntries(buffer: Buffer): { name: string; content: Buffer; crc: number }[] {
  const entries: { name: string; content: Buffer; crc: number }[] = [];
  let offset = 0;
  while (offset < buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const crc = buffer.readUInt32LE(offset + 14);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const contentStart = nameStart + nameLength + extraLength;
    entries.push({
      name: buffer.subarray(nameStart, nameStart + nameLength).toString("utf8"),
      content: buffer.subarray(contentStart, contentStart + size),
      crc,
    });
    offset = contentStart + size;
  }
  return entries;
}
