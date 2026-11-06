import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messageEvents, organizations } from "@/lib/db/schema";
import { newMessageKey } from "@/lib/crypto";
import { newStorageKey, writeBody } from "@/lib/storage/bodies";
import { RetentionLoop } from "@/worker/retention";
import { messageRow, resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

function loop(opts: { batchSize?: number; intervalMs?: number } = {}): RetentionLoop {
  return new RetentionLoop({ intervalMs: opts.intervalMs ?? 60_000, batchSize: opts.batchSize ?? 100 });
}

async function setRetentionDays(orgId: string, days: number) {
  await db.update(organizations).set({ bodyRetentionDays: days }).where(eq(organizations.id, orgId));
}

async function makeMessage(fixture: Fixture, opts: { createdAgo: number; bodyKey?: string | null }): Promise<string> {
  const id = `msg_${Math.random().toString(36).slice(2, 26).padEnd(24, "0").slice(0, 24)}`;
  const createdAt = new Date(Date.now() - opts.createdAgo);
  const storageKey = newStorageKey();
  const { key: buf, encoded } = newMessageKey();
  if (opts.bodyKey !== null) {
    await writeBody(buf, storageKey, { html: "<p>x</p>", text: "x", textGenerated: false, attachments: [] });
  }
  return seedMessage(fixture, {
    id,
    subject: "Row",
    to: "you@example.net",
    storageKey,
    bodyKey: opts.bodyKey === null ? null : encoded,
    createdAt,
  });
}

const DAY = 24 * 60 * 60 * 1000;

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

describe("RetentionLoop", () => {
  it("shreds keys for messages past the org's retention", async () => {
    await setRetentionDays(fixture.organizationId, 7);
    const oldId = await makeMessage(fixture, { createdAgo: 8 * DAY });

    const { shredded, orgs } = await loop().tick();

    expect(shredded).toBe(1);
    expect(orgs).toBe(1);
    const after = await messageRow(oldId);
    expect(after.bodyKey).toBeNull();
    expect(after.bodyPurgedAt).not.toBeNull();
  });

  it("puts the shred on the message's timeline, with the window it was past", async () => {
    await setRetentionDays(fixture.organizationId, 7);
    const id = await makeMessage(fixture, { createdAgo: 8 * DAY });

    await loop().tick();
    await loop().tick();

    const events = await db.select().from(messageEvents).where(eq(messageEvents.messageId, id));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("body_shredded");
    expect(events[0]?.status).toBeNull();
    expect(events[0]?.detail.retentionDays).toBe(7);
  });

  it("leaves messages inside the retention window alone", async () => {
    await setRetentionDays(fixture.organizationId, 7);
    const newId = await makeMessage(fixture, { createdAgo: 2 * DAY });

    const { shredded } = await loop().tick();

    expect(shredded).toBe(0);
    const after = await messageRow(newId);
    expect(after.bodyKey).not.toBeNull();
    expect(after.bodyPurgedAt).toBeNull();
  });

  it("respects each organization's own retention days", async () => {
    const other = await seedFixture();
    await setRetentionDays(fixture.organizationId, 7);
    await setRetentionDays(other.organizationId, 90);

    const shortOrgOld = await makeMessage(fixture, { createdAgo: 14 * DAY });
    const longOrgOld = await makeMessage(other, { createdAgo: 14 * DAY });

    await loop().tick();

    expect((await messageRow(shortOrgOld)).bodyKey).toBeNull();
    expect((await messageRow(longOrgOld)).bodyKey).not.toBeNull();
  });

  it("does not re-shred a row that's already been swept", async () => {
    await setRetentionDays(fixture.organizationId, 7);
    const id = await makeMessage(fixture, { createdAgo: 14 * DAY });

    await loop().tick();
    const afterFirst = await messageRow(id);

    const { shredded } = await loop().tick();
    expect(shredded).toBe(0);

    const afterSecond = await messageRow(id);
    expect(afterSecond.bodyPurgedAt?.toISOString()).toBe(afterFirst.bodyPurgedAt?.toISOString());
  });

  it("leaves a row whose bodyKey was already null alone", async () => {
    await setRetentionDays(fixture.organizationId, 7);
    const id = await makeMessage(fixture, { createdAgo: 14 * DAY, bodyKey: null });

    const { shredded } = await loop().tick();

    expect(shredded).toBe(0);
    const after = await messageRow(id);
    expect(after.bodyKey).toBeNull();
  });

  it("respects batchSize so a backlog can't pin the worker", async () => {
    await setRetentionDays(fixture.organizationId, 7);
    for (let i = 0; i < 5; i++) await makeMessage(fixture, { createdAgo: 14 * DAY });

    const { shredded } = await loop({ batchSize: 2 }).tick();
    expect(shredded).toBe(2);
  });
});