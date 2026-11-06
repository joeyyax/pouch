import { beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { messageHourlyStats, messages } from "@/lib/db/schema";
import type { MessageStatus } from "@/lib/db/schema";
import { readOutcomes } from "@/lib/stats/outcomes";
import { rollupMessageStats } from "@/lib/stats/rollup";
import { addDomainKey, resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

const NOW = new Date("2026-09-08T12:34:56.000Z");
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let fixture: Fixture;
let second: Awaited<ReturnType<typeof addDomainKey>>;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture({ scopeToDomain: false });
  second = await addDomainKey(fixture, "second.example.com");
});

async function send(agoMs: number, status: MessageStatus = "delivered", options: { domainId?: string; testMode?: boolean } = {}): Promise<string> {
  return seedMessage(
    { organizationId: fixture.organizationId, domainId: options.domainId ?? fixture.domainId },
    { status, createdAt: new Date(NOW.getTime() - agoMs), testMode: options.testMode ?? false },
  );
}

/** Seventy days across two domains and both modes, every status, with edges off the hour. */
async function seedHistory(): Promise<void> {
  const statuses: MessageStatus[] = ["delivered", "bounced", "complained", "failed", "sent", "deferred", "queued"];
  for (let step = 0; step < 70 * 6; step += 1) {
    const agoMs = step * 4 * HOUR + 13 * MINUTE;
    await send(agoMs, statuses[step % statuses.length]);
    if (step % 2 === 0) await send(agoMs + 31 * MINUTE, statuses[(step + 3) % statuses.length], { domainId: second.domainId });
    if (step % 5 === 0) await send(agoMs, "bounced", { testMode: true });
  }
}

const WINDOWS: [number, number][] = [
  [7 * DAY, 0],
  [14 * DAY, 7 * DAY],
  [30 * DAY, 0],
  [60 * DAY, 30 * DAY],
  [8 * DAY, DAY],
];

function readAll() {
  return Promise.all(
    WINDOWS.map(([from, to]) =>
      readOutcomes({ organizationId: fixture.organizationId }, new Date(NOW.getTime() - from), new Date(NOW.getTime() - to), NOW),
    ),
  );
}

describe("outcome counts", () => {
  it("answer from the rollup with the numbers a live count gives", async () => {
    await seedHistory();
    const live = await readAll();

    await rollupMessageStats(NOW);
    expect(await readAll()).toEqual(live);
    expect(live[0]!.get(fixture.domainId)?.total).toBeGreaterThan(30);
    expect(live[0]!.get(second.domainId)?.total).toBeGreaterThan(15);

    // The rollup is what answered: a cell changed by hand shows through.
    const [cell] = await db
      .select({ hour: messageHourlyStats.hour })
      .from(messageHourlyStats)
      .where(and(eq(messageHourlyStats.domainId, second.domainId), eq(messageHourlyStats.testMode, false)))
      .orderBy(desc(messageHourlyStats.hour))
      .limit(1);
    await db
      .update(messageHourlyStats)
      .set({ bounced: sql`${messageHourlyStats.bounced} + 5` })
      .where(and(eq(messageHourlyStats.domainId, second.domainId), eq(messageHourlyStats.hour, cell!.hour), eq(messageHourlyStats.testMode, false)));
    const [rolled] = await readAll();
    expect(rolled!.get(second.domainId)?.bounced).toBe(live[0]!.get(second.domainId)!.bounced + 5);
  });

  it("count an hour live once a message in it changes", async () => {
    const id = await send(5 * DAY, "delivered");
    await rollupMessageStats(NOW);
    await db.update(messages).set({ status: "bounced", updatedAt: new Date(NOW.getTime() + 10 * MINUTE) }).where(eq(messages.id, id));

    const at = new Date(NOW.getTime() + 20 * MINUTE);
    const counts = await readOutcomes({ organizationId: fixture.organizationId }, new Date(at.getTime() - 7 * DAY), at, at);
    expect(counts.get(fixture.domainId)).toMatchObject({ total: 1, bounced: 1, delivered: 0 });
  });

  it("leave test mode out and keep to the domains asked for", async () => {
    await send(3 * DAY, "bounced", { testMode: true });
    await send(3 * DAY, "delivered", { domainId: second.domainId });
    await rollupMessageStats(NOW);

    const counts = await readOutcomes({ organizationId: fixture.organizationId, domainIds: [fixture.domainId] }, new Date(NOW.getTime() - 7 * DAY), NOW, NOW);
    expect(counts.size).toBe(0);
  });
});
