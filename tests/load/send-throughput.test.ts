/**
 * Accept and send throughput against the mock provider. Not part of `pnpm test`: run `pnpm test:load`.
 * LOAD_MESSAGES, LOAD_WORKER_CONCURRENCY, LOAD_PROVIDER_CONCURRENCY and MOCK_SEND_LATENCY_MS tune it; LOAD_REPORT names a file for the numbers.
 */
import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages } from "@/lib/db/schema";
import { acceptMessage } from "@/lib/messages/create";
import { resetMockSends } from "@/lib/providers/adapters/mock";
import { SendLoop } from "@/worker/loop";
import { resetDatabase, seedFixture } from "../integration/fixtures";

const MESSAGES = Number(process.env.LOAD_MESSAGES ?? 2000);
const WORKER_CONCURRENCY = Number(process.env.LOAD_WORKER_CONCURRENCY ?? 8);
const PROVIDER_CONCURRENCY = Number(process.env.LOAD_PROVIDER_CONCURRENCY ?? 4);
process.env.MOCK_SEND_LATENCY_MS ??= "120";

async function sentCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(messages).where(eq(messages.status, "sent"));
  return row?.n ?? 0;
}

function rate(n: number, ms: number): string {
  return `${(n / (ms / 1000)).toFixed(1)}/s`;
}

describe("send throughput", () => {
  it(`accepts and sends ${MESSAGES} messages`, async () => {
    await resetDatabase();
    resetMockSends();
    const fixture = await seedFixture({ concurrency: PROVIDER_CONCURRENCY });

    const acceptStart = performance.now();
    const ACCEPT_PARALLEL = 16;
    for (let i = 0; i < MESSAGES; i += ACCEPT_PARALLEL) {
      await Promise.all(
        Array.from({ length: Math.min(ACCEPT_PARALLEL, MESSAGES - i) }, (_, j) =>
          acceptMessage(fixture.key, { from: "Ada <ada@example.com>", to: [`person${i + j}@example.net`], subject: `Receipt ${i + j}`, html: `<p>Order ${i + j} is on its way.</p>` }, null),
        ),
      );
    }
    const acceptMs = performance.now() - acceptStart;

    const loop = new SendLoop({ workerId: "load", maxConcurrency: WORKER_CONCURRENCY, pollIntervalMs: 200 });
    const sendStart = performance.now();
    loop.start();
    let sent = 0;
    while (sent < MESSAGES && performance.now() - sendStart < 590_000) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      sent = await sentCount();
    }
    const sendMs = performance.now() - sendStart;
    await loop.stop();

    appendFileSync(
      process.env.LOAD_REPORT ?? "/dev/stderr",
      [
        `messages ${MESSAGES}, worker ${WORKER_CONCURRENCY}, provider ${PROVIDER_CONCURRENCY}, provider latency ${process.env.MOCK_SEND_LATENCY_MS}ms`,
        `accept ${rate(MESSAGES, acceptMs)} (${(acceptMs / 1000).toFixed(1)}s, ${ACCEPT_PARALLEL} in parallel)`,
        `send   ${rate(sent, sendMs)} (${(sendMs / 1000).toFixed(1)}s), ceiling from slots ${rate(PROVIDER_CONCURRENCY, Number(process.env.MOCK_SEND_LATENCY_MS))}`,
      ]
        .join("\n") + "\n\n",
    );
    expect(sent).toBe(MESSAGES);
  });
});
