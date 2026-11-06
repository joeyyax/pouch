import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { messageEvents, messages, suppressions } from "@/lib/db/schema";
import { acceptMessage } from "@/lib/messages/create";
import { claimMessages, dueProviders } from "@/lib/messages/queue";
import { resetMockSends } from "@/lib/providers/adapters/mock";
import { deliver } from "@/worker/send";
import { TestModeLoop } from "@/worker/test-mode";
import type { SendEmailRequest } from "@/lib/schemas/email";
import { messageRow, resetDatabase, seedFixture, type Fixture } from "./fixtures";

function request(to: string): SendEmailRequest {
  return { from: "Ada <ada@example.com>", to: [to], subject: "Hello", html: "<p>Hi</p>" };
}

async function queue(fixture: Fixture, to: string): Promise<string> {
  const { message } = await acceptMessage(fixture.key, request(to), null);
  return message.id;
}

async function events(id: string) {
  return db.select().from(messageEvents).where(eq(messageEvents.messageId, id));
}

async function isSuppressed(organizationId: string, address: string): Promise<boolean> {
  const [found] = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(and(eq(suppressions.organizationId, organizationId), eq(suppressions.address, address)))
    .limit(1);
  return found !== undefined;
}

/** Claims and delivers every due message, the way the real worker does. */
async function sendAll(workerId = "worker-test"): Promise<void> {
  for (const provider of await dueProviders()) {
    const claimed = await claimMessages({ workerId, providerId: provider.id, limit: 10 });
    for (const item of claimed) await deliver(item);
  }
}

function loop(opts: { batchSize?: number; intervalMs?: number; delayMs?: number } = {}): TestModeLoop {
  return new TestModeLoop({
    intervalMs: opts.intervalMs ?? 60_000,
    batchSize: opts.batchSize ?? 100,
    delayMs: opts.delayMs ?? 0,
  });
}

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  resetMockSends();
  fixture = await seedFixture({ keyMode: "test" });
});

describe("TestModeLoop", () => {
  it.each([
    ["person@example.net", "delivered"],
    ["bounce@example.net", "bounced"],
    ["defer@example.net", "deferred"],
  ])("resolves a test-mode message to %s as %s through the same apply-event path a webhook uses", async (address, status) => {
    const id = await queue(fixture, address);
    await sendAll();
    expect((await messageRow(id)).status).toBe("sent");
    expect(await isSuppressed(fixture.organizationId, address)).toBe(false);

    const { resolved } = await loop().tick();

    expect(resolved).toBe(1);
    const after = await messageRow(id);
    expect(after.status).toBe(status);
    expect(after.deliveredAt === null).toBe(status !== "delivered");

    const rows = await events(id);
    expect(rows.map((event) => event.status)).toContain(status);

    expect(await isSuppressed(fixture.organizationId, address)).toBe(status === "bounced");
  });

  it("waits longer than the base delay before resolving a slow@ address", async () => {
    const id = await queue(fixture, "slow@example.net");
    await sendAll();

    // Past the base delay, but not past SLOW_DELAY_MULTIPLIER times it — left alone.
    await db
      .update(messages)
      .set({ sentAt: new Date((await dbNow()).getTime() - 1500) })
      .where(eq(messages.id, id));
    const notYet = await loop({ delayMs: 1000 }).tick();
    expect(notYet.resolved).toBe(0);
    expect((await messageRow(id)).status).toBe("sent");

    // Past the extended wait now — resolves to delivered, same as any other address.
    await db
      .update(messages)
      .set({ sentAt: new Date((await dbNow()).getTime() - 4500) })
      .where(eq(messages.id, id));
    const { resolved } = await loop({ delayMs: 1000 }).tick();
    expect(resolved).toBe(1);
    expect((await messageRow(id)).status).toBe("delivered");
  });

  it("leaves a test-mode message alone until its delay has passed", async () => {
    const id = await queue(fixture, "person@example.net");
    await sendAll();

    const { resolved } = await loop({ delayMs: 60_000 }).tick();

    expect(resolved).toBe(0);
    expect((await messageRow(id)).status).toBe("sent");
  });

  it("never touches a live-mode message", async () => {
    const live = await seedFixture({ keyMode: "live" });
    const id = await queue(live, "person@example.net");
    await sendAll();
    expect((await messageRow(id)).status).toBe("sent");

    const { resolved } = await loop().tick();

    expect(resolved).toBe(0);
    expect((await messageRow(id)).status).toBe("sent");
  });

  it("does not resolve the same message twice", async () => {
    const id = await queue(fixture, "person@example.net");
    await sendAll();

    await loop().tick();
    const { resolved } = await loop().tick();

    expect(resolved).toBe(0);
    expect((await messageRow(id)).status).toBe("delivered");
  });
});
