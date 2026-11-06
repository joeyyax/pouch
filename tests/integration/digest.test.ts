import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { messageEvents, messages, reputationStates, users } from "@/lib/db/schema";
import type { MessageStatus } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { currentWindow, dueCadences } from "@/lib/mail/digest/cadence";
import { readDigestSummary } from "@/lib/mail/digest/metrics";
import { runDigest } from "@/lib/mail/digest/send";
import { readDigestPreferences, updateDigestPreferences } from "@/lib/mail/digest/preferences";
import { redeemUnsubscribeToken, signUnsubscribeToken, verifyUnsubscribeToken } from "@/lib/mail/digest/unsubscribe";
import { readBody } from "@/lib/storage/bodies";
import { resetDatabase, seedFixture, seedMessage as seedFixtureMessage, seedSystemOrganization, systemMailMessages, type Fixture } from "./fixtures";

const DAY = 86_400_000;
/** A Monday, so the weekly window's boundaries land where the test expects. */
const NOW = new Date("2026-09-14T00:30:00.000Z");

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

async function makeOperator(email: string): Promise<string> {
  const userId = crypto.randomUUID();
  await db.insert(users).values({
    id: userId,
    organizationId: fixture.organizationId,
    name: "Admin",
    email,
    admin: true,
  });
  return userId;
}

async function seedMessage(options: { status?: MessageStatus; agoMs: number; testMode?: boolean; providerId?: string }): Promise<string> {
  const createdAt = new Date(NOW.getTime() - options.agoMs);
  return seedFixtureMessage(fixture, {
    status: options.status ?? "delivered",
    providerId: options.providerId ?? null,
    testMode: options.testMode ?? false,
    from: "ada@example.com",
    to: "person@example.net",
    subject: "Hello",
    createdAt,
    nextAttemptAt: createdAt,
  });
}

describe("dueCadences", () => {
  it("fires nothing off the hour boundary", () => {
    expect(dueCadences(new Date("2026-09-14T12:30:00.000Z"), 0)).toEqual([]);
  });

  it("fires daily every day at hour 0, weekly on Monday, monthly on the 1st", () => {
    expect(dueCadences(new Date("2026-09-09T00:00:00.000Z"), 0)).toEqual(["daily"]); // Wednesday
    expect(dueCadences(new Date("2026-09-14T00:00:00.000Z"), 0)).toEqual(["daily", "weekly"]); // Monday
    expect(dueCadences(new Date("2026-10-01T00:00:00.000Z"), 0)).toEqual(["daily", "monthly"]); // 1st, a Thursday
  });

  it("fires at the hour the operator set, and not at midnight", () => {
    expect(dueCadences(new Date("2026-09-14T13:20:00.000Z"), 13)).toEqual(["daily", "weekly"]);
    expect(dueCadences(new Date("2026-09-14T00:00:00.000Z"), 13)).toEqual([]);
  });
});

describe("currentWindow", () => {
  it("covers the calendar day before, for daily", () => {
    const window = currentWindow("daily", NOW);
    expect(window.since.toISOString()).toBe("2026-09-13T00:00:00.000Z");
    expect(window.until.toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });

  it("covers the Monday-starting week before, for weekly", () => {
    const window = currentWindow("weekly", NOW);
    expect(window.since.toISOString()).toBe("2026-09-07T00:00:00.000Z");
    expect(window.until.toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });
});

describe("readDigestSummary", () => {
  it("buckets the day by hour, splits by provider and organization, and lists what moved to watch", async () => {
    const window = currentWindow("daily", NOW);
    const hourIn = (hour: number) => NOW.getTime() - (window.since.getTime() + hour * 3_600_000 + 15 * 60_000);
    await seedMessage({ agoMs: hourIn(2), providerId: fixture.providerId });
    await seedMessage({ agoMs: hourIn(2), providerId: fixture.providerId, status: "bounced" });
    await seedMessage({ agoMs: hourIn(19) });
    await db.insert(reputationStates).values({
      organizationId: fixture.organizationId,
      subjectType: "domain",
      subjectId: fixture.domainId,
      standing: "at_risk",
      changedAt: new Date(window.since.getTime() + 3_600_000),
    });

    const summary = await readDigestSummary(window);

    expect(summary?.buckets).toHaveLength(24);
    expect(summary?.buckets.filter((bucket) => bucket.total > 0).map((bucket) => [bucket.start.getUTCHours(), bucket.total])).toEqual([[2, 2], [19, 1]]);
    expect(summary?.providers).toEqual([expect.objectContaining({ total: 2, bounced: 1 })]);
    expect(summary?.organizations).toEqual([expect.objectContaining({ total: 3, bounced: 1 })]);
    expect(summary?.attention.standingChanges).toEqual([expect.objectContaining({ standing: "at_risk" })]);
  });
});

describe("runDigest", () => {
  it("sends nothing when the window is empty", async () => {
    await seedSystemOrganization();
    await makeOperator("admin@example.com");

    const sent = await runDigest(currentWindow("weekly", NOW));

    expect(sent).toBe(0);
    expect(await systemMailMessages()).toHaveLength(0);
  });

  it("mails every opted-in admin, addressed to their own provider", async () => {
    await seedSystemOrganization();
    await makeOperator("admin@example.com");
    await seedMessage({ status: "delivered", agoMs: DAY }); // inside the weekly window
    await seedMessage({ status: "bounced", agoMs: 2 * DAY });
    await seedMessage({ status: "delivered", agoMs: 10 * DAY }); // outside the window

    const sent = await runDigest(currentWindow("weekly", NOW));

    expect(sent).toBe(1);
    const [message] = await systemMailMessages();
    expect(message!.envelope.to).toEqual(["admin@example.com"]);
    expect(message!.subject).toBe("Week of September 7 digest: 2 sent");
    expect(message!.tags).toContain("digest-weekly");

    const headerNames = Object.keys(message!.envelope.headers).map((name) => name.toLowerCase());
    expect(headerNames).toContain("list-unsubscribe");
    expect(headerNames).toContain("list-unsubscribe-post");
  });

  it("counts a system alert in the organization it sent from, and skips a test-mode send", async () => {
    const { organizationId: systemOrgId, domainId: systemDomainId } = await seedSystemOrganization();
    await makeOperator("admin@example.com");
    await seedMessage({ status: "delivered", agoMs: DAY });
    await seedMessage({ status: "delivered", agoMs: DAY, testMode: true });

    // A system alert in the organization system mail sends from, inside the same window.
    await db.insert(messages).values({
      id: newId("message"),
      organizationId: systemOrgId,
      domainId: systemDomainId,
      status: "delivered",
      fromAddress: "support@example.org",
      recipients: ["support@example.org"],
      subject: "System alert",
      envelope: {
        from: "support@example.org",
        fromName: null,
        to: ["support@example.org"],
        cc: [],
        bcc: [],
        replyTo: [],
        headers: {},
        attachmentCount: 0,
      },
      createdAt: new Date(NOW.getTime() - DAY),
      nextAttemptAt: new Date(NOW.getTime() - DAY),
    });

    const sent = await runDigest(currentWindow("weekly", NOW));
    expect(sent).toBe(1);
    const digestMessage = (await systemMailMessages()).find((row) => row.subject.startsWith("Week of"));
    expect(digestMessage!.subject).toBe("Week of September 7 digest: 2 sent"); // the alert counts where it sent from; the test-mode send never does
  });

  it("names the provider's own bounce reasons", async () => {
    await seedSystemOrganization();
    await makeOperator("admin@example.com");
    const messageId = await seedMessage({ status: "bounced", agoMs: DAY });
    await db.insert(messageEvents).values({
      id: newId("event"),
      organizationId: fixture.organizationId,
      messageId,
      status: "bounced",
      reason: "Mailbox does not exist",
      detail: {},
      occurredAt: new Date(NOW.getTime() - DAY),
    });

    await runDigest(currentWindow("weekly", NOW));

    const [message] = await systemMailMessages();
    const body = await readBody(Buffer.from(message!.bodyKey ?? "", "base64"), message!.storageKey ?? "");
    expect(body?.text).toContain("Mailbox does not exist");
    expect(body?.text).toContain(`Turn off the weekly digest`);
  });

  it("is idempotent by window and recipient: a second run doesn't send twice", async () => {
    await seedSystemOrganization();
    await makeOperator("admin@example.com");
    await seedMessage({ status: "delivered", agoMs: DAY });

    const window = currentWindow("weekly", NOW);
    await runDigest(window);
    await runDigest(window);

    const rows = await systemMailMessages();
    expect(rows.filter((row) => row.tags.includes("digest-weekly"))).toHaveLength(1);
  });

  it("skips an admin who turned the cadence off", async () => {
    await seedSystemOrganization();
    const operatorId = await makeOperator("admin@example.com");
    await updateDigestPreferences(operatorId, { daily: false, weekly: false, monthly: false });
    await seedMessage({ status: "delivered", agoMs: DAY });

    const sent = await runDigest(currentWindow("weekly", NOW));
    expect(sent).toBe(0);
  });
});

describe("unsubscribe tokens", () => {
  it("round-trips: a signed token verifies back to the same user and cadence", () => {
    const token = signUnsubscribeToken("user-1", "weekly");
    expect(verifyUnsubscribeToken(token)).toEqual({ userId: "user-1", cadence: "weekly" });
  });

  it("rejects a forged or truncated token", () => {
    const token = signUnsubscribeToken("user-1", "weekly");
    expect(verifyUnsubscribeToken(`${token}x`)).toBeNull();
    expect(verifyUnsubscribeToken("not-a-token")).toBeNull();
  });

  it("turns the named cadence off and leaves the others alone", async () => {
    await seedSystemOrganization();
    const operatorId = await makeOperator("admin@example.com");
    await updateDigestPreferences(operatorId, { daily: true, weekly: true, monthly: true });

    const token = signUnsubscribeToken(operatorId, "weekly");
    const result = await redeemUnsubscribeToken(token);

    expect(result).toEqual({ cadence: "weekly", email: "admin@example.com" });
    const preferences = await readDigestPreferences(operatorId);
    expect(preferences).toEqual({ daily: true, weekly: false, monthly: true });
  });

  it("unsubscribing actually stops the next digest from reaching that admin", async () => {
    await seedSystemOrganization();
    const operatorId = await makeOperator("admin@example.com");
    await seedMessage({ status: "delivered", agoMs: DAY });

    await redeemUnsubscribeToken(signUnsubscribeToken(operatorId, "weekly"));
    const sent = await runDigest(currentWindow("weekly", NOW));

    expect(sent).toBe(0);
  });
});
