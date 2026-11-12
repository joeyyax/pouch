import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { activity, domains, messages, type MessageStatus } from "@/lib/db/schema";
import { userActor } from "@/lib/activity/record";
import {
  domainOutcomeWindow,
  domainsDueForStallCheck,
  releaseDomainStall,
  stallDomain,
  stallStateFor,
} from "@/lib/domains/stall";
import { DEFAULT_STALL_LINES, type StallVerdict } from "@/lib/domains/guard";
import { StallGuardLoop } from "@/worker/stall-guard";
import { STALL_RECHECK_MS, deliver } from "@/worker/send";
import { claimMessages, dueProviders } from "@/lib/messages/queue";
import { acceptMessage } from "@/lib/messages/create";
import { sendPushAlert } from "@/lib/notifications/push/push";
import { resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

vi.mock("@/lib/notifications/push/push", () => ({ sendPushAlert: vi.fn().mockResolvedValue(undefined) }));

const DAY_MS = 24 * 60 * 60 * 1000;

let fixture: Fixture;

async function insertMessage(options: {
  status: MessageStatus;
  createdAt: Date;
  testMode?: boolean;
}): Promise<string> {
  return seedMessage(fixture, {
    status: options.status,
    to: "person@example.net",
    subject: "Hello",
    testMode: options.testMode ?? false,
    createdAt: options.createdAt,
  });
}

async function domainRow() {
  const [row] = await db.select().from(domains).where(eq(domains.id, fixture.domainId)).limit(1);
  if (!row) throw new Error("fixture domain disappeared");
  return row;
}

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
  vi.mocked(sendPushAlert).mockClear();
});

describe("domainOutcomeWindow", () => {
  it("counts only messages created inside the window", async () => {
    const now = await dbNow();
    await insertMessage({ status: "bounced", createdAt: new Date(now.getTime() - 1000) });
    await insertMessage({ status: "bounced", createdAt: new Date(now.getTime() - 30 * DAY_MS) });

    const counts = await domainOutcomeWindow({ id: fixture.domainId, organizationId: fixture.organizationId }, new Date(now.getTime() - DAY_MS), now, now);
    expect(counts.bounced).toBe(1);
  });

  it("excludes test-mode messages from both sides of the rate", async () => {
    const now = await dbNow();
    const createdAt = new Date(now.getTime() - 1000);
    await insertMessage({ status: "bounced", createdAt, testMode: true });
    await insertMessage({ status: "delivered", createdAt, testMode: true });

    const counts = await domainOutcomeWindow({ id: fixture.domainId, organizationId: fixture.organizationId }, new Date(now.getTime() - DAY_MS), now, now);
    expect(counts.bounced).toBe(0);
    expect(counts.delivered).toBe(0);
  });
});

const verdict: StallVerdict = {
  reason: "bounce_rate",
  detail: { metric: "bounce", count: 10, denominator: 100, rate: 0.1, previousRate: 0.1, threshold: DEFAULT_STALL_LINES.bounce.stall },
};

describe("stallDomain", () => {
  it("sets the hold and records why", async () => {
    const now = await dbNow();
    const wrote = await stallDomain(await domainRow(), verdict, now);

    expect(wrote).toBe(true);
    const domain = await domainRow();
    expect(domain.stalledAt).toEqual(now);
    expect(domain.stallReason).toBe("bounce_rate");
    expect(domain.stallDetail).toEqual(verdict.detail);

    const rows = await db.select().from(activity).where(eq(activity.appliesTo, fixture.domainId));
    expect(rows.map((row) => row.action)).toContain("domain.stalled");
    expect(rows[0]?.actorType).toBe("worker");
  });

  it("keeps the original reason and timestamp on a domain already stalled", async () => {
    const first = await dbNow();
    await stallDomain(await domainRow(), verdict, first);

    const second = new Date(first.getTime() + 60_000);
    const wrote = await stallDomain(await domainRow(), { ...verdict, reason: "complaint_rate" }, second);

    expect(wrote).toBe(false);
    const domain = await domainRow();
    expect(domain.stalledAt).toEqual(first);
    expect(domain.stallReason).toBe("bounce_rate");
    expect(sendPushAlert).toHaveBeenCalledTimes(1);
  });
});

describe("the stall push alert", () => {
  it("names the domain, the reason and the number", async () => {
    const domain = await domainRow();
    await stallDomain(domain, verdict, await dbNow());

    expect(sendPushAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: `Domain paused: ${domain.name}`,
        message: "Bounce rate is 10.00%, above our 2.50% action point.",
      }),
    );
  });
});

describe("domains_stall_pairing_check", () => {
  const constraintOf = (error: unknown) => (error as { cause?: { constraint_name?: string } }).cause?.constraint_name;

  it("refuses a stall without a reason", async () => {
    const error = await db.update(domains).set({ stalledAt: await dbNow() }).where(eq(domains.id, fixture.domainId)).then(() => null, (e) => e);
    expect(constraintOf(error)).toBe("domains_stall_pairing_check");
  });

  it("refuses a reason without a stall", async () => {
    const error = await db.update(domains).set({ stallReason: "bounce_rate" }).where(eq(domains.id, fixture.domainId)).then(() => null, (e) => e);
    expect(constraintOf(error)).toBe("domains_stall_pairing_check");
  });
});

describe("releaseDomainStall", () => {
  it("clears the hold and records who released it", async () => {
    await stallDomain(await domainRow(), verdict, await dbNow());

    const released = await releaseDomainStall(fixture.organizationId, fixture.domainId, userActor("u_1", "Ada"), await dbNow());

    expect(released.stalledAt).toBeNull();
    expect(released.stallReason).toBeNull();
    expect(released.stallDetail).toBeNull();

    const rows = await db.select().from(activity).where(eq(activity.appliesTo, fixture.domainId));
    expect(rows.map((row) => row.action)).toContain("domain.stall.released");
  });

  it("keeps the domain sending on the numbers it released", async () => {
    await stallDomain(await domainRow(), verdict, await dbNow());
    await releaseDomainStall(fixture.organizationId, fixture.domainId, userActor("u_1", "Ada"), await dbNow());

    expect(await stallDomain(await domainRow(), verdict, await dbNow())).toBe(false);
    const worse = { ...verdict, detail: { ...verdict.detail, count: verdict.detail.count + 1 } };
    expect(await stallDomain(await domainRow(), worse, await dbNow())).toBe(true);
  });

  it("is a no-op, with no activity row, on a domain that isn't stalled", async () => {
    await releaseDomainStall(fixture.organizationId, fixture.domainId, userActor("u_1", "Ada"), await dbNow());

    const rows = await db.select().from(activity).where(eq(activity.appliesTo, fixture.domainId));
    expect(rows).toHaveLength(0);
  });

  it("throws for a domain outside the organization", async () => {
    await expect(
      releaseDomainStall("org_other", fixture.domainId, userActor("u_1", "Ada"), await dbNow()),
    ).rejects.toThrow();
  });
});

describe("stallStateFor", () => {
  it("reports only the stalled ids among those asked about", async () => {
    await stallDomain(await domainRow(), verdict, await dbNow());
    const state = await stallStateFor([fixture.domainId, "dom_unrelated"]);

    expect(state.has(fixture.domainId)).toBe(true);
    expect(state.has("dom_unrelated")).toBe(false);
  });
});

describe("the stall guard's sweep", () => {
  it("stalls a domain whose recent bounce rate crosses the action point", async () => {
    const now = await dbNow();
    const bounced = 5;
    const delivered = 95;
    for (let i = 0; i < bounced; i++) await insertMessage({ status: "bounced", createdAt: now });
    for (let i = 0; i < delivered; i++) await insertMessage({ status: "delivered", createdAt: now });

    const loop = new StallGuardLoop({ intervalMs: 60_000, batchSize: 10, recheckAfterMs: 0 });
    await loop.tick();

    const domain = await domainRow();
    expect(domain.stalledAt).not.toBeNull();
    expect(domain.stallReason).toBe("bounce_rate");
  });

  it("never stalls a domain whose rate stays under the action point", async () => {
    const now = await dbNow();
    for (let i = 0; i < 2; i++) await insertMessage({ status: "bounced", createdAt: now });
    for (let i = 0; i < 98; i++) await insertMessage({ status: "delivered", createdAt: now });

    const loop = new StallGuardLoop({ intervalMs: 60_000, batchSize: 10, recheckAfterMs: 0 });
    await loop.tick();

    expect((await domainRow()).stalledAt).toBeNull();
  });

  it("stamps the check even on a domain that stays healthy, so it doesn't jump the queue next pass", async () => {
    await insertMessage({ status: "delivered", createdAt: await dbNow() });

    const loop = new StallGuardLoop({ intervalMs: 60_000, batchSize: 10, recheckAfterMs: 0 });
    await loop.tick();

    expect((await domainRow()).stallCheckedAt).not.toBeNull();
  });

  it("skips a domain checked inside the recheck interval", async () => {
    const now = await dbNow();
    await insertMessage({ status: "delivered", createdAt: now });
    await db.update(domains).set({ stallCheckedAt: new Date(now.getTime() - 60_000) }).where(eq(domains.id, fixture.domainId));

    const due = await domainsDueForStallCheck(new Date(now.getTime() - 5 * 60_000), 10);
    expect(due.find((row) => row.id === fixture.domainId)).toBeUndefined();
  });

  it("[control] rechecks the same domain once the interval has passed", async () => {
    const now = await dbNow();
    await insertMessage({ status: "delivered", createdAt: now });
    await db.update(domains).set({ stallCheckedAt: new Date(now.getTime() - 10 * 60_000) }).where(eq(domains.id, fixture.domainId));

    const due = await domainsDueForStallCheck(new Date(now.getTime() - 5 * 60_000), 10);
    expect(due.find((row) => row.id === fixture.domainId)).toBeDefined();
  });

  it("doesn't stall a domain the sweep checked inside the interval, and does once it's due", async () => {
    const now = await dbNow();
    for (let i = 0; i < 5; i++) await insertMessage({ status: "bounced", createdAt: now });
    for (let i = 0; i < 95; i++) await insertMessage({ status: "delivered", createdAt: now });
    await db.update(domains).set({ stallCheckedAt: now }).where(eq(domains.id, fixture.domainId));

    await new StallGuardLoop({ intervalMs: 60_000, batchSize: 10, recheckAfterMs: 5 * 60_000 }).tick();
    expect((await domainRow()).stalledAt).toBeNull();

    await db.update(domains).set({ stallCheckedAt: new Date(now.getTime() - 10 * 60_000) }).where(eq(domains.id, fixture.domainId));
    await new StallGuardLoop({ intervalMs: 60_000, batchSize: 10, recheckAfterMs: 5 * 60_000 }).tick();
    expect((await domainRow()).stalledAt).not.toBeNull();
  });

  it("leaves an unverified domain alone — nothing sends from it yet to guard", async () => {
    await db.update(domains).set({ status: "pending" }).where(eq(domains.id, fixture.domainId));
    const now = await dbNow();
    for (let i = 0; i < 10; i++) await insertMessage({ status: "bounced", createdAt: now });

    const due = await domainsDueForStallCheck(new Date(now.getTime() + DAY_MS), 10);
    expect(due.find((row) => row.id === fixture.domainId)).toBeUndefined();
  });
});

describe("the send path, while a domain is held", () => {
  async function queue(to = "person@example.net"): Promise<string> {
    const { message } = await acceptMessage(
      fixture.key,
      { from: "Ada <ada@example.com>", to: [to], subject: "Hello", html: "<p>Hi</p>" },
      null,
    );
    return message.id;
  }

  async function claim(workerId = "worker-a") {
    const claimed = [];
    for (const provider of await dueProviders()) {
      claimed.push(...(await claimMessages({ workerId, providerId: provider.id, limit: 10 })));
    }
    return claimed;
  }

  it("puts a claimed message back to queued, untouched, rather than sending it", async () => {
    const id = await queue();
    const claimed = await claim();
    await stallDomain(await domainRow(), verdict, await dbNow());

    for (const item of claimed) await deliver(item, "worker-a");

    const [row] = await db.select().from(messages).where(eq(messages.id, id));
    expect(row?.status).toBe("queued");
    expect(row?.attempts).toBe(0);
    expect(row?.lockedBy).toBeNull();
    expect(row?.failureReason).toBeNull();
    expect(row?.nextAttemptAt.getTime()).toBeGreaterThanOrEqual((await dbNow()).getTime() + STALL_RECHECK_MS - 1000);
  });

  it("sends normally again once the stall is released", async () => {
    const id = await queue();
    await stallDomain(await domainRow(), verdict, await dbNow());

    const heldClaim = await claim();
    for (const item of heldClaim) await deliver(item, "worker-a");
    expect((await db.select().from(messages).where(eq(messages.id, id)))[0]?.status).toBe("queued");

    await releaseDomainStall(fixture.organizationId, fixture.domainId, userActor("u_1", "Ada"), await dbNow());
    // The hold pushed next_attempt_at into the future; pull it back so this test doesn't wait.
    await db.update(messages).set({ nextAttemptAt: await dbNow() }).where(eq(messages.id, id));

    const released = await claim();
    for (const item of released) await deliver(item, "worker-a");

    const row = (await db.select().from(messages).where(eq(messages.id, id)))[0];
    expect(row?.status).toBe("sent");
  });
});
