import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { messageEvents } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { resetDatabase, seedFixture, seedMessage } from "./fixtures";

beforeEach(resetDatabase);

const migration = readFileSync("drizzle/0081_backfill_body_shredded_events.sql", "utf8");

async function run(): Promise<void> {
  for (const statement of migration.split("--> statement-breakpoint")) await db.execute(sql.raw(statement));
}

const eventsFor = (messageId: string) =>
  db.select().from(messageEvents).where(eq(messageEvents.messageId, messageId)).orderBy(asc(messageEvents.createdAt));

describe("the migration that records shreds 0077 made without an event", () => {
  it("backfills once, from body_purged_at, and leaves the rest alone", async () => {
    const fixture = await seedFixture();
    const purgedAt = new Date("2026-08-01T12:00:00Z");
    const missing = await seedMessage(fixture, { bodyWithheld: "a sign-in link", bodyKey: null, bodyPurgedAt: purgedAt });
    const recorded = await seedMessage(fixture, { bodyWithheld: "a sign-in link", bodyKey: null, bodyPurgedAt: purgedAt });
    const unshredded = await seedMessage(fixture, { bodyWithheld: "a sign-in link", bodyKey: "key", bodyPurgedAt: null });
    const plain = await seedMessage(fixture, { bodyWithheld: null, bodyKey: null, bodyPurgedAt: purgedAt });

    const existingId = newId("event");
    await db.insert(messageEvents).values({
      id: existingId,
      organizationId: fixture.organizationId,
      messageId: recorded,
      kind: "body_shredded",
      detail: { retentionDays: null },
      occurredAt: purgedAt,
    });

    await run();
    await run();

    const [event, ...extra] = await eventsFor(missing);
    expect(extra).toEqual([]);
    expect(event).toMatchObject({
      organizationId: fixture.organizationId,
      messageId: missing,
      kind: "body_shredded",
      status: null,
      detail: { retentionDays: null },
    });
    expect(event?.id).toMatch(/^evt_[0-9a-z]{24}$/);
    expect(event?.occurredAt).toEqual(purgedAt);

    expect((await eventsFor(recorded)).map((row) => row.id)).toEqual([existingId]);
    expect(await eventsFor(unshredded)).toEqual([]);
    expect(await eventsFor(plain)).toEqual([]);
  });

  it("gives each backfilled event its own id", async () => {
    const fixture = await seedFixture();
    for (let i = 0; i < 5; i++) await seedMessage(fixture, { bodyWithheld: "a reset link", bodyKey: null, bodyPurgedAt: new Date() });
    await run();
    const rows = await db.select({ id: messageEvents.id }).from(messageEvents);
    expect(new Set(rows.map((row) => row.id)).size).toBe(5);
  });
});
