import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messageEvents, type MessageStatus } from "@/lib/db/schema";
import { ABANDON_MS } from "@/lib/metrics/conditions";
import { AbandonLoop } from "@/worker/abandon";
import { messageRow, resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

function loop(opts: { batchSize?: number; intervalMs?: number } = {}): AbandonLoop {
  return new AbandonLoop({ intervalMs: opts.intervalMs ?? 60_000, batchSize: opts.batchSize ?? 100 });
}

async function makeMessage(
  fixture: Fixture,
  opts: { sentAgo: number | null; status?: MessageStatus },
): Promise<string> {
  const now = Date.now();
  const sentAt = opts.sentAgo === null ? null : new Date(now - opts.sentAgo);
  const createdAt = sentAt ?? new Date(now);
  return seedMessage(fixture, {
    status: opts.status ?? "sent",
    subject: "Row",
    to: "you@example.net",
    createdAt,
    sentAt,
  });
}

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

describe("AbandonLoop", () => {
  it("marks a sent message the provider never reported on past the window", async () => {
    const id = await makeMessage(fixture, { sentAgo: ABANDON_MS + 60_000 });

    const { marked } = await loop().tick();

    expect(marked).toBe(1);
    const after = await messageRow(id);
    expect(after.status).toBe("sent");
    expect(after.abandonedAt).not.toBeNull();
  });

  it("leaves a message inside the window alone", async () => {
    const id = await makeMessage(fixture, { sentAgo: ABANDON_MS - 60_000 });

    const { marked } = await loop().tick();

    expect(marked).toBe(0);
    const after = await messageRow(id);
    expect(after.abandonedAt).toBeNull();
  });

  it("puts the mark on the message's timeline", async () => {
    const id = await makeMessage(fixture, { sentAgo: ABANDON_MS + 60_000 });

    await loop().tick();

    const events = await db.select().from(messageEvents).where(eq(messageEvents.messageId, id));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("abandoned");
    expect(events[0]?.status).toBeNull();
  });

  it("leaves a status other than sent alone, however old", async () => {
    const id = await makeMessage(fixture, { sentAgo: ABANDON_MS + 60_000, status: "delivered" });

    const { marked } = await loop().tick();

    expect(marked).toBe(0);
    const after = await messageRow(id);
    expect(after.abandonedAt).toBeNull();
  });

  it("does not re-mark a row that's already been swept", async () => {
    const id = await makeMessage(fixture, { sentAgo: ABANDON_MS + 60_000 });

    await loop().tick();
    const afterFirst = await messageRow(id);

    const { marked } = await loop().tick();
    expect(marked).toBe(0);

    const afterSecond = await messageRow(id);
    expect(afterSecond.abandonedAt?.toISOString()).toBe(afterFirst.abandonedAt?.toISOString());
  });

  it("respects batchSize so a backlog can't pin the worker", async () => {
    for (let i = 0; i < 5; i++) await makeMessage(fixture, { sentAgo: ABANDON_MS + 60_000 });

    const { marked } = await loop({ batchSize: 2 }).tick();
    expect(marked).toBe(2);
  });
});
