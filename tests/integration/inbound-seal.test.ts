import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { inboundMessages, webhookDeliveries, type InboundMessageRow } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { getObject, putObject } from "@/lib/storage";
import { inboundBodyKey, newInboundStorageKey, readInboundBody, readInboundObject } from "@/lib/inbound/attachments";
import { enqueueInboundDelivery } from "@/lib/inbound/deliver";
import { openInboundDownload } from "@/lib/inbound/downloads";
import { countLegacyInbound, sealLegacyInbound } from "@/lib/inbound/seal";
import { serializeInboundWithLinks } from "@/lib/inbound/serialize";
import { upsertDomainEndpoint } from "@/lib/webhooks/endpoints";
import { main as sealScript } from "@/scripts/seal-inbound";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

vi.mock("node:dns/promises", () => ({ lookup: () => Promise.resolve([{ address: "203.0.113.9", family: 4 }]) }));

const { failingKeys } = vi.hoisted(() => ({ failingKeys: new Set<string>() }));

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    deleteObject: async (...args: Parameters<typeof actual.deleteObject>) => {
      if (failingKeys.has(args[1])) throw new Error("simulated storage failure");
      return actual.deleteObject(...args);
    },
  };
});

const DAY = 24 * 60 * 60 * 1000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x10, 0x80]);
const RAW = Buffer.from("From: ada@example.net\r\nSubject: Plans\r\n\r\nthe secret plans\r\n");

/** A row as ingest wrote it before #487: body in the columns, objects in plaintext. */
async function legacyRow(fixture: Fixture, overrides: Partial<InboundMessageRow> = {}): Promise<InboundMessageRow> {
  const prefix = newInboundStorageKey();
  await putObject("private", `${prefix}/0`, PNG, "image/png");
  await putObject("private", `${prefix}/raw`, RAW, "message/rfc822");
  const [row] = await db
    .insert(inboundMessages)
    .values({
      id: newId("inbound"),
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      fromAddress: "ada@example.net",
      to: ["reply@inbound.example.com"],
      subject: "Plans",
      text: "the secret plans",
      html: "<p>the secret plans</p>",
      attachments: [{ filename: "plan.png", contentType: "image/png", size: PNG.length, storageKey: `${prefix}/0` }],
      rawStorageKey: `${prefix}/raw`,
      threadId: newId("thread"),
      receivedAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * DAY),
      ...overrides,
    })
    .returning();
  return row!;
}

async function reread(id: string): Promise<InboundMessageRow> {
  const [row] = await db.select().from(inboundMessages).where(eq(inboundMessages.id, id));
  return row!;
}

function tokenOf(url: string): string {
  return new URL(url).pathname.split("/").pop()!;
}

beforeEach(resetDatabase);
afterEach(() => failingKeys.clear());

describe("sealing legacy inbound mail", () => {
  it("reads a legacy row from its columns and plaintext objects before it's sealed", async () => {
    const fixture = await seedFixture();
    const row = await legacyRow(fixture);

    const message = await serializeInboundWithLinks(row);
    expect(message.text).toBe("the secret plans");
    const opened = await openInboundDownload(tokenOf(message.attachments[0]!.download_url!));
    expect(opened?.content.equals(PNG)).toBe(true);
  });

  it("moves the body into sealed storage, re-seals the objects and deletes the plaintext", async () => {
    const fixture = await seedFixture();
    const row = await legacyRow(fixture);
    const plainAttachment = row.attachments[0]!.storageKey!;
    expect(await countLegacyInbound()).toBe(1);

    const result = await sealLegacyInbound();
    expect(result).toMatchObject({ sealed: 1, failed: 0 });
    expect(await countLegacyInbound()).toBe(0);

    const sealed = await reread(row.id);
    expect(sealed.text).toBeNull();
    expect(sealed.html).toBeNull();
    expect(sealed.bodyKey).not.toBeNull();
    expect(await readInboundBody(sealed)).toEqual({ text: "the secret plans", html: "<p>the secret plans</p>" });
    expect((await readInboundObject(sealed, sealed.attachments[0]!.storageKey!)).equals(PNG)).toBe(true);
    expect((await readInboundObject(sealed, sealed.rawStorageKey!)).equals(RAW)).toBe(true);

    expect(await getObject("private", inboundBodyKey(sealed.storageKey!))).not.toContain("secret");
    expect(await getObject("private", sealed.rawStorageKey!)).not.toContain("secret");
    await expect(getObject("private", plainAttachment)).rejects.toThrow();
    await expect(getObject("private", row.rawStorageKey!)).rejects.toThrow();

    const message = await serializeInboundWithLinks(sealed);
    expect(message.html).toBe("<p>the secret plans</p>");
    const raw = await openInboundDownload(tokenOf(message.raw_download_url!));
    expect(raw?.content.equals(RAW)).toBe(true);
  });

  it("does nothing the second time", async () => {
    const fixture = await seedFixture();
    const row = await legacyRow(fixture);
    await sealLegacyInbound();
    const first = await reread(row.id);

    expect(await sealLegacyInbound()).toMatchObject({ sealed: 0, failed: 0 });
    const second = await reread(row.id);
    expect(second.bodyKey).toBe(first.bodyKey);
    expect(second.storageKey).toBe(first.storageKey);
    expect(await readInboundBody(second)).toEqual({ text: "the secret plans", html: "<p>the secret plans</p>" });
  });

  it("finishes deleting the plaintext on a rerun after a run stopped past the claim", async () => {
    const fixture = await seedFixture();
    const row = await legacyRow(fixture);
    failingKeys.add(row.rawStorageKey!);

    expect(await sealLegacyInbound()).toMatchObject({ sealed: 0, failed: 2 });
    expect((await reread(row.id)).bodyKey).not.toBeNull();
    await expect(getObject("private", row.rawStorageKey!)).resolves.toContain("secret");

    failingKeys.clear();
    expect(await sealLegacyInbound()).toMatchObject({ sealed: 0, failed: 0, swept: 1 });
    await expect(getObject("private", row.rawStorageKey!)).rejects.toThrow();
  });

  it("leaves quarantined rows and mail about to expire alone", async () => {
    const fixture = await seedFixture();
    const quarantined = await legacyRow(fixture, { text: null, html: null, attachments: [], rawStorageKey: null });
    const expiring = await legacyRow(fixture, { expiresAt: new Date(Date.now() - 1000) });

    expect(await sealLegacyInbound()).toMatchObject({ sealed: 0 });
    expect((await reread(quarantined.id)).bodyKey).toBeNull();
    expect((await reread(expiring.id)).text).toBe("the secret plans");
  });

  it("nulls bodies in stored payloads whose message is already gone, and keeps the rest", async () => {
    const fixture = await seedFixture();
    const { endpoint } = await upsertDomainEndpoint(fixture.organizationId, fixture.domainId, "https://receiver.example.net/hook");
    const live = await legacyRow(fixture);
    const gone = await legacyRow(fixture);
    await enqueueInboundDelivery(endpoint, live, { text: live.text, html: live.html });
    await enqueueInboundDelivery(endpoint, gone, { text: gone.text, html: gone.html });
    await db.delete(inboundMessages).where(eq(inboundMessages.id, gone.id));

    expect((await sealLegacyInbound()).payloadsScrubbed).toBe(1);

    const byId = new Map(
      (await db.select().from(webhookDeliveries)).map((delivery) => {
        const data = (delivery.payload as { data: { id: string; text: string | null } }).data;
        return [data.id, data.text];
      }),
    );
    expect(byId.get(gone.id)).toBeNull();
    expect(byId.get(live.id)).toBe("the secret plans");
  });

  it("reports counts before and after from the script", async () => {
    const fixture = await seedFixture();
    await legacyRow(fixture);
    await legacyRow(fixture);
    const lines: string[] = [];

    expect(await sealScript(["--dry-run"], (line) => lines.push(line))).toBe(0);
    expect(await countLegacyInbound()).toBe(2);
    expect(await sealScript(["--batch", "1"], (line) => lines.push(line))).toBe(0);
    expect(lines[0]).toBe("2 inbound message(s) hold plaintext");
    expect(lines.at(-1)).toMatch(/^sealed 2, failed 0, .* 0 still hold plaintext, 0 of them past retention\.$/);
  });
});
