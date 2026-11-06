import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { activity } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import type { ActivityCursor } from "@/lib/activity/types";
import { listActivityEntries } from "@/lib/dashboard/activity-entries";
import { activityEntriesByDay } from "@/lib/dashboard/views/activity-entries";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

const MINUTE = 60_000;
const BASE = new Date("2026-09-01T20:00:00.000Z").getTime();
const FILTERS = { families: [], outcomes: [], actors: [], since: null };

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

/** Rows `minutes` before BASE. A gap over five minutes starts a new entry; a smaller one extends a run. */
async function seed(minutes: number[]): Promise<string[]> {
  const ids: string[] = [];
  for (const offset of minutes) {
    const id = newId("activity");
    ids.push(id);
    await db.insert(activity).values({
      id,
      organizationId: fixture.organizationId,
      action: "session.sign_in",
      family: "session",
      outcome: "success",
      actorType: "worker",
      actorId: null,
      actorLabel: "Pouch",
      createdAt: new Date(BASE - offset * MINUTE),
    });
  }
  return ids;
}

function runSizes(rows: Parameters<typeof activityEntriesByDay>[0]): number[] {
  return activityEntriesByDay(rows, "UTC").flatMap((day) => day.groups.map((group) => group.count));
}

async function walk(options: Parameters<typeof listActivityEntries>[4]) {
  const pages: Awaited<ReturnType<typeof listActivityEntries>>["rows"][] = [];
  let cursor: ActivityCursor | null = null;
  for (let i = 0; i < 50; i += 1) {
    const page = await listActivityEntries(fixture.organizationId, FILTERS, "UTC", cursor, options);
    pages.push(page.rows);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return pages;
}

describe("listActivityEntries", () => {
  it("fills a page with whole entries rather than raw rows", async () => {
    const run = Array.from({ length: 8 }, (_, i) => i);
    const singles = Array.from({ length: 40 }, (_, i) => 20 + i * 10);
    const ids = await seed([...run, ...singles]);

    const pages = await walk({});
    expect(pages.map((rows) => runSizes(rows).length)).toEqual([25, 16]);
    expect(runSizes(pages[0] ?? [])[0]).toBe(8);
    expect(pages.flat().map((row) => row.id).sort()).toEqual([...ids].sort());
  });

  it("never splits a run that crosses a read batch", async () => {
    // A single, then a run of six whose first four rows end the first batch, then a single.
    const ids = await seed([0, 10, 11, 12, 13, 14, 15, 30]);
    const pages = await walk({ entries: 2, batch: 5 });
    expect(pages.map(runSizes)).toEqual([[1, 6], [1]]);
    expect(pages.flat().map((row) => row.id).sort()).toEqual([...ids].sort());
  });

  it("splits only a run longer than the scan cap, and counts each row once", async () => {
    const ids = await seed(Array.from({ length: 12 }, (_, i) => i));
    const pages = await walk({ batch: 5, maxScan: 5 });
    expect(pages.map((rows) => rows.length)).toEqual([5, 5, 2]);
    expect(new Set(pages.flat().map((row) => row.id)).size).toBe(12);
    expect(pages.flat().map((row) => row.id).sort()).toEqual([...ids].sort());
  });
});
