/** How fast provider delivery events apply. Not part of `pnpm test`: run `pnpm test:load`. LOAD_EVENTS sets the count. */
import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages } from "@/lib/db/schema";
import { applyEvent } from "@/lib/messages/events";
import { eventSource, resetDatabase, seedFixture, seedMessage } from "../integration/fixtures";

const EVENTS = Number(process.env.LOAD_EVENTS ?? 2000);
/** Callbacks in flight at once, as SNS delivers them. */
const IN_FLIGHT = 32;

describe("event throughput", () => {
  it(`applies ${EVENTS} delivery events`, async () => {
    await resetDatabase();
    const fixture = await seedFixture();
    const ids: string[] = [];
    for (let i = 0; i < EVENTS; i += 500) {
      ids.push(
        ...(await Promise.all(
          Array.from({ length: Math.min(500, EVENTS - i) }, (_, j) =>
            seedMessage(fixture, { status: "sent", providerId: fixture.providerId, providerMessageId: `load_${i + j}`, to: `person${i + j}@example.net` }),
          ),
        )),
      );
    }

    const source = eventSource(fixture);
    const start = performance.now();
    let next = 0;
    await Promise.all(
      Array.from({ length: IN_FLIGHT }, async () => {
        while (next < EVENTS) {
          const i = next++;
          await applyEvent(source, {
            providerMessageId: `load_${i}`,
            providerEventId: `evt_load_${i}`,
            status: "delivered",
            reason: null,
            occurredAt: new Date(),
            detail: {},
            recipients: [`person${i}@example.net`],
          });
        }
      }),
    );
    const ms = performance.now() - start;

    appendFileSync(process.env.LOAD_REPORT ?? "/dev/stderr", `events ${EVENTS}: applied in ${(ms / 1000).toFixed(1)}s, ${(EVENTS / (ms / 1000)).toFixed(0)}/s, ${IN_FLIGHT} in flight\n\n`);
    const [row] = await db.select({ n: count() }).from(messages).where(eq(messages.status, "delivered"));
    expect(row?.n).toBe(EVENTS);
  });
});
