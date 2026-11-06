import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { inboundMessages, webhookDeliveries } from "@/lib/db/schema";
import { newMessageKey } from "@/lib/crypto";
import { upsertDomainEndpoint } from "@/lib/webhooks/endpoints";
import { enqueueInboundDelivery } from "@/lib/inbound/deliver";
import { newId } from "@/lib/ids";
import { getObject } from "@/lib/storage";
import { inboundBodyKey, newInboundStorageKey, writeInboundAttachments, writeInboundBody, writeInboundRaw } from "@/lib/inbound/attachments";
import { InboundRetentionLoop } from "@/worker/inbound-retention";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

/** Lets one test make deleteObject reject for a chosen key, to prove a transient object-storage
 * failure leaves that row (and its object) alone rather than dropping the row anyway. */
const { failingKeys } = vi.hoisted(() => ({ failingKeys: new Set<string>() }));

vi.mock("node:dns/promises", () => ({ lookup: () => Promise.resolve([{ address: "203.0.113.9", family: 4 }]) }));

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    deleteObject: async (...args: Parameters<typeof actual.deleteObject>) => {
      const [, key] = args;
      if (failingKeys.has(key)) throw new Error("simulated storage failure");
      return actual.deleteObject(...args);
    },
  };
});

function loop(): InboundRetentionLoop {
  return new InboundRetentionLoop({ intervalMs: 60_000, batchSize: 100 });
}

async function makeInboundMessage(fixture: Fixture, opts: { expiresAgo: number; withAttachment: boolean }) {
  const id = newId("inbound");
  const { key, encoded } = newMessageKey();
  const storageKey = newInboundStorageKey();
  await writeInboundBody(key, storageKey, { text: "hello", html: null });
  const attachments = opts.withAttachment
    ? await writeInboundAttachments(storageKey, key, [{ filename: "a.txt", contentType: "text/plain", content: Buffer.from("hello") }])
    : [];

  const [row] = await db
    .insert(inboundMessages)
    .values({
      id,
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      fromAddress: "ada@example.net",
      to: ["reply@inbound.example.com"],
      subject: "Hi",
      threadId: newId("thread"),
      attachments,
      bodyKey: encoded,
      storageKey,
      receivedAt: new Date(),
      expiresAt: new Date(Date.now() - opts.expiresAgo),
    })
    .returning();
  return { id, attachments, storageKey, key, row: row! };
}

beforeEach(resetDatabase);
afterEach(() => {
  failingKeys.clear();
});

describe("inbound retention sweep", () => {
  it("purges a message row past its expiry, and its attachment object with it", async () => {
    const fixture = await seedFixture();
    const { id, attachments } = await makeInboundMessage(fixture, { expiresAgo: 1000, withAttachment: true });
    const storageKey = attachments[0]!.storageKey!;

    // The object exists before the sweep.
    await expect(getObject("private", storageKey)).resolves.toBeTruthy();

    const result = await loop().tick();
    expect(result.purged).toBe(1);

    const [row] = await db.select().from(inboundMessages).where(eq(inboundMessages.id, id));
    expect(row).toBeUndefined();

    // The row is gone; a quiet data-retention violation would be the object still sitting there.
    await expect(getObject("private", storageKey)).rejects.toThrow();
  });

  it("purges the raw message with the row", async () => {
    const fixture = await seedFixture();
    const { id } = await makeInboundMessage(fixture, { expiresAgo: 1000, withAttachment: false });
    const { storageKey, key } = await db.select().from(inboundMessages).where(eq(inboundMessages.id, id)).then(([row]) => ({ storageKey: row!.storageKey!, key: Buffer.from(row!.bodyKey!, "base64") }));
    const rawStorageKey = await writeInboundRaw(storageKey, key, Buffer.from("From: ada@example.net\r\n\r\nhi"));
    await db.update(inboundMessages).set({ rawStorageKey }).where(eq(inboundMessages.id, id));

    expect((await loop().tick()).purged).toBe(1);
    await expect(getObject("private", rawStorageKey)).rejects.toThrow();
  });

  it("purges the sealed body object with the row", async () => {
    const fixture = await seedFixture();
    const { storageKey } = await makeInboundMessage(fixture, { expiresAgo: 1000, withAttachment: false });
    await expect(getObject("private", inboundBodyKey(storageKey))).resolves.toBeTruthy();

    expect((await loop().tick()).purged).toBe(1);
    await expect(getObject("private", inboundBodyKey(storageKey))).rejects.toThrow();
  });

  it("nulls the body in stored webhook payloads when the message goes, and keeps the delivery", async () => {
    const fixture = await seedFixture();
    const endpoint = await upsertDomainEndpoint(fixture.organizationId, fixture.domainId, "https://receiver.example.net/hook");
    const expired = await makeInboundMessage(fixture, { expiresAgo: 1000, withAttachment: false });
    const kept = await makeInboundMessage(fixture, { expiresAgo: -DAY, withAttachment: false });
    await enqueueInboundDelivery(endpoint.endpoint, expired.row, { text: "secret text", html: "<p>secret</p>" });
    await enqueueInboundDelivery(endpoint.endpoint, kept.row, { text: "still here", html: null });

    expect((await loop().tick()).purged).toBe(1);

    const payloads = new Map(
      (await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.organizationId, fixture.organizationId))).map((delivery) => {
        const data = (delivery.payload as { data: { id: string; text: string | null; html: string | null; subject: string } }).data;
        return [data.id, data];
      }),
    );
    expect(payloads.get(expired.id)).toMatchObject({ text: null, html: null, subject: "Hi" });
    expect(JSON.stringify(payloads.get(expired.id))).not.toContain("secret");
    expect(payloads.get(kept.id)).toMatchObject({ text: "still here" });
  });

  it("leaves a message whose retention window hasn't passed yet", async () => {
    const fixture = await seedFixture();
    const { id } = await makeInboundMessage(fixture, { expiresAgo: -DAY, withAttachment: false });

    const result = await loop().tick();
    expect(result.purged).toBe(0);

    const [row] = await db.select().from(inboundMessages).where(eq(inboundMessages.id, id));
    expect(row).toBeDefined();
  });

  it("leaves a row whose attachment object failed to delete, and purges its siblings", async () => {
    const fixture = await seedFixture();
    const { id: okId } = await makeInboundMessage(fixture, { expiresAgo: 1000, withAttachment: true });
    const { id: failId, attachments } = await makeInboundMessage(fixture, { expiresAgo: 1000, withAttachment: true });
    failingKeys.add(attachments[0]!.storageKey!);

    const result = await loop().tick();
    expect(result.purged).toBe(1);

    const [okRow] = await db.select().from(inboundMessages).where(eq(inboundMessages.id, okId));
    expect(okRow).toBeUndefined();

    // The failing row survives — deleted here would mean its attachment object outlives it,
    // unreachable and unproviderable, exactly the violation the sweep exists to prevent.
    const [failedRow] = await db.select().from(inboundMessages).where(eq(inboundMessages.id, failId));
    expect(failedRow).toBeDefined();
    await expect(getObject("private", attachments[0]!.storageKey!)).resolves.toBeTruthy();

    // Once storage recovers, the next tick picks the row back up.
    failingKeys.clear();
    const second = await loop().tick();
    expect(second.purged).toBe(1);
    const [retried] = await db.select().from(inboundMessages).where(eq(inboundMessages.id, failId));
    expect(retried).toBeUndefined();
  });

  it("purges multiple expired messages across domains in one pass", async () => {
    const fixtureA = await seedFixture();
    const fixtureB = await seedFixture();
    await makeInboundMessage(fixtureA, { expiresAgo: 1000, withAttachment: true });
    await makeInboundMessage(fixtureB, { expiresAgo: 1000, withAttachment: true });

    const result = await loop().tick();
    expect(result.purged).toBe(2);

    const remaining = await db.select().from(inboundMessages);
    expect(remaining).toHaveLength(0);
  });
});

const DAY = 24 * 60 * 60 * 1000;
