import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { domainBlocklistChecks, memberships, reputationStates, users } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { acceptMessage } from "@/lib/messages/create";
import { claimMessages, dueProviders } from "@/lib/messages/queue";
import { mockSends, resetMockSends } from "@/lib/providers/adapters/mock";
import { sendPushAlert } from "@/lib/notifications/push/push";
import { sendNotification } from "@/lib/notifications/send";
import type { ReputationAlertInput } from "@/lib/mail/alerts/reputation-changed";
import { closeRedis, redis } from "@/lib/redis";
import { budgetDay, QUERY_CEILING } from "@/lib/blocklists/budget";
import { setBlocklistLookup, type BlocklistLookup } from "@/lib/blocklists/dns";
import { LINK_CHECK_TIMEOUT_MS } from "@/lib/blocklists/links";
import { blocklistStatus, KEY_ENV } from "@/lib/blocklists/status";
import { readDomainReputation, readOrganizationReputation } from "@/lib/reputation/read";
import { deliver } from "@/worker/send";
import { BlocklistLoop } from "@/worker/blocklists";
import { messageRow, resetDatabase, seedFixture, seedSystemOrganization, systemMailMessages, type Fixture } from "./fixtures";
import { clearRedisKeys, testRedisUrl } from "../redis";

vi.mock("@/lib/notifications/push/push", () => ({ sendPushAlert: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/notifications/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notifications/send")>();
  return { ...actual, sendNotification: vi.fn(actual.sendNotification) };
});

const REDIS_URL = testRedisUrl();
const KEY = "testkeytestkeytestkeytestk";
const DBL = `${KEY}.dbl.dq.spamhaus.net`;
const ZRD = `${KEY}.zrd.dq.spamhaus.net`;

let fixture: Fixture;
let queried: string[];

/** Answers from a table; anything not in it is NXDOMAIN. Spamhaus's test entry is always listed. */
function answering(answers: Record<string, string[]>): BlocklistLookup {
  return async (name) => {
    queried.push(name);
    if (name === `dbltest.com.${DBL}`) return ["127.0.1.2"];
    return answers[name] ?? [];
  };
}

const hanging: BlocklistLookup = (name) => {
  queried.push(name);
  return new Promise<string[]>(() => undefined);
};

function loop(): BlocklistLoop {
  return new BlocklistLoop({ intervalMs: 60_000, batchSize: 50 });
}

async function addOwner(): Promise<string> {
  const userId = crypto.randomUUID();
  const email = `owner-${userId.slice(0, 8)}@owners.example`;
  await db.insert(users).values({ id: userId, organizationId: fixture.organizationId, name: "Owner", email });
  await db.insert(memberships).values({ id: newId("membership"), userId, organizationId: fixture.organizationId, role: "owner" });
  return email;
}

async function sendHtml(html: string): Promise<string> {
  const { message } = await acceptMessage(fixture.key, { from: "ada@example.com", to: ["person@example.net"], subject: "Hi", html }, null);
  for (const provider of await dueProviders()) {
    for (const claimed of await claimMessages({ workerId: "worker-test", providerId: provider.id, limit: 10 })) {
      await deliver(claimed, "worker-test");
    }
  }
  return message.id;
}

async function standing(subjectId: string) {
  const [row] = await db.select().from(reputationStates).where(eq(reputationStates.subjectId, subjectId));
  return row?.standing ?? "healthy";
}

beforeEach(async () => {
  process.env.REDIS_URL = REDIS_URL;
  process.env[KEY_ENV] = KEY;
  await clearRedisKeys("blocklists:");
  await resetDatabase();
  resetMockSends();
  fixture = await seedFixture();
  queried = [];
  vi.mocked(sendPushAlert).mockClear();
  vi.mocked(sendNotification).mockClear();
});
afterEach(async () => {
  setBlocklistLookup();
  await clearRedisKeys("blocklists:");
  delete process.env[KEY_ENV];
  delete process.env.REDIS_URL;
  await closeRedis();
});

describe("the daily sending-domain check", () => {
  it("raises a DBL-listed domain to at risk and emails owners the list and how to request removal", async () => {
    await seedSystemOrganization();
    const owner = await addOwner();
    setBlocklistLookup(answering({ [`example.com.${DBL}`]: ["127.0.1.2"] }));

    // The system organization's own domain is checked too.
    expect(await loop().tick()).toBe(2);

    expect(queried[0]).toBe(`dbltest.com.${DBL}`);
    expect(queried).toEqual(expect.arrayContaining([`example.com.${DBL}`, `example.com.${ZRD}`]));
    const [row] = await db.select().from(domainBlocklistChecks)
      .where(and(eq(domainBlocklistChecks.domainId, fixture.domainId), eq(domainBlocklistChecks.list, "dbl")));
    expect(row).toMatchObject({ status: "listed", code: "127.0.1.2", reason: "spam domain" });
    expect(await standing(fixture.domainId)).toBe("at_risk");

    const alert = vi.mocked(sendNotification).mock.calls.find(([notification]) => notification.appliesTo === fixture.domainId)?.[0];
    expect(alert?.type).toBe("standing_at_risk");
    const findings = (alert?.input as ReputationAlertInput | undefined)?.findings ?? [];
    expect(findings[0]).toMatchObject({ kind: "blocklist_listing", title: "example.com is on Spamhaus DBL" });
    expect(findings[0]?.action).toContain("https://check.spamhaus.org");
    const mail = (await systemMailMessages()).filter((message) => message.recipients.includes(owner));
    expect(mail.map((message) => message.subject)).toContain("On a blocklist: example.com");
    expect(vi.mocked(sendPushAlert).mock.calls.some(([push]) => push.title === "At risk: example.com")).toBe(true);
  });

  it("doesn't check a domain again inside a day", async () => {
    setBlocklistLookup(answering({}));
    await loop().tick();
    queried = [];
    expect(await loop().tick()).toBe(0);
    expect(queried).toEqual([]);
    expect(await standing(fixture.domainId)).toBe("healthy");
  });

  it("reads a refused-query code as a check error, not a listing, and warns the operator", async () => {
    setBlocklistLookup(answering({ [`example.com.${DBL}`]: ["127.255.255.254"] }));

    await loop().tick();

    const [row] = await db.select().from(domainBlocklistChecks).where(eq(domainBlocklistChecks.list, "dbl"));
    expect(row).toMatchObject({ status: null, lastError: "refused (127.255.255.254)" });
    const reputation = await readOrganizationReputation(fixture.organizationId, await dbNow());
    expect(reputation.domains.get(fixture.domainId)?.standing).toBe("healthy");
    expect(await standing(fixture.domainId)).toBe("healthy");
    expect(vi.mocked(sendPushAlert).mock.calls.map(([push]) => push.title)).toEqual(["Blocklist key isn't working"]);
    expect(await blocklistStatus(await dbNow())).toMatchObject({ state: "key_invalid" });
  });

  it("checks nothing when Spamhaus's test entry doesn't come back listed", async () => {
    setBlocklistLookup(async (name) => {
      queried.push(name);
      return name.startsWith("dbltest.com.") ? ["127.255.255.252"] : ["127.0.1.2"];
    });

    expect(await loop().tick()).toBe(0);

    expect(queried).toEqual([`dbltest.com.${DBL}`]);
    expect(await db.select().from(domainBlocklistChecks)).toEqual([]);
    expect(await blocklistStatus(await dbNow())).toEqual({ state: "key_invalid", detail: "Spamhaus: the key isn't valid." });
  });

  it("stops at the day's query ceiling and warns once", async () => {
    setBlocklistLookup(answering({}));
    await redis()!.set(`blocklists:queries:${budgetDay(await dbNow())}`, String(QUERY_CEILING.sweep));

    expect(await loop().tick()).toBe(0);
    await loop().tick();

    expect(queried).toEqual([]);
    const warnings = vi.mocked(sendPushAlert).mock.calls.filter(([push]) => push.title === "Blocklist query budget reached");
    expect(warnings).toHaveLength(1);
    expect(await blocklistStatus(await dbNow())).toMatchObject({ state: "paused" });
  });

  it("counts each query against the day", async () => {
    setBlocklistLookup(answering({}));
    await loop().tick();
    expect(await redis()!.get(`blocklists:queries:${budgetDay(await dbNow())}`)).toBe("3");
  });

  it("does nothing without a key", async () => {
    delete process.env[KEY_ENV];
    setBlocklistLookup(answering({}));
    expect(await loop().tick()).toBe(0);
    expect(queried).toEqual([]);
    expect(await blocklistStatus(await dbNow())).toEqual({ state: "off" });
  });
});

describe("link-domain checks at send", () => {
  it("stores a listed link on the message and raises the sending domain to at risk", async () => {
    setBlocklistLookup(answering({ [`bad.example.net.${DBL}`]: ["127.0.1.4"] }));

    const id = await sendHtml(`<a href="https://bad.example.net/login">Log in</a> <a href="https://example.com/">Home</a>`);

    const row = await messageRow(id);
    expect(row.status).toBe("sent");
    expect(row.linkListings).toEqual([{ domain: "bad.example.net", list: "dbl", code: "127.0.1.4", reason: "phish domain" }]);
    const reputation = await readDomainReputation(fixture.organizationId, fixture.domainId, await dbNow());
    expect(reputation?.standing).toBe("at_risk");
    expect(reputation?.findings[0]).toMatchObject({ kind: "linked_domain_listing" });
    expect(reputation?.blocklists.links).toMatchObject([{ domain: "bad.example.net", messages: 1 }]);
  });

  it("caches answers so a repeated link doesn't query again", async () => {
    setBlocklistLookup(answering({}));
    const first = await sendHtml(`<a href="https://shop.example.net/">Shop</a>`);
    const second = await sendHtml(`<a href="https://shop.example.net/sale">Sale</a>`);

    expect(queried).toEqual([`shop.example.net.${DBL}`, `shop.example.net.${ZRD}`]);
    expect((await messageRow(first)).linkListings).toBeNull();
    expect((await messageRow(second)).linkListings).toBeNull();
  });

  it("sends on time when DNS hangs, and leaves the message unchecked", async () => {
    setBlocklistLookup(hanging);

    const started = performance.now();
    const id = await sendHtml(`<a href="https://slow.example.net/">Link</a>`);
    const elapsed = performance.now() - started;

    expect(queried.length).toBeGreaterThan(0);
    expect(mockSends()).toHaveLength(1);
    const row = await messageRow(id);
    expect(row.status).toBe("sent");
    expect(row.linkListings).toBeNull();
    expect(elapsed).toBeLessThan(LINK_CHECK_TIMEOUT_MS + 1500);
  });

  it("skips link checks once the link budget is spent", async () => {
    setBlocklistLookup(answering({ [`bad.example.net.${DBL}`]: ["127.0.1.4"] }));
    await redis()!.set(`blocklists:queries:${budgetDay(await dbNow())}`, String(QUERY_CEILING.links));

    const id = await sendHtml(`<a href="https://bad.example.net/">Link</a>`);

    expect(queried).toEqual([]);
    expect((await messageRow(id)).status).toBe("sent");
    expect(vi.mocked(sendPushAlert).mock.calls.map(([push]) => push.title)).toEqual(["Blocklist query budget reached"]);
  });

  it("never stores a refused-query code as a listing", async () => {
    setBlocklistLookup(answering({ [`bad.example.net.${DBL}`]: ["127.255.255.254"] }));

    const id = await sendHtml(`<a href="https://bad.example.net/">Link</a>`);

    expect((await messageRow(id)).linkListings).toBeNull();
    expect(await blocklistStatus(await dbNow())).toMatchObject({ state: "key_invalid" });
  });
});
