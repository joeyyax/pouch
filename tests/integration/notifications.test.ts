/** Notifications (#572): email by default, throttled per subject, silenced per owner, per install or by the organization's mutes. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, domainDailyStats, memberships, messages, notificationPreferences, notificationSends, reputationStates, users } from "@/lib/db/schema";
import { userActor, workerActor } from "@/lib/activity/record";
import type { OrgRole } from "@/lib/auth/permissions";
import { newId } from "@/lib/ids";
import { sendSystemMail } from "@/lib/mail/system";
import { renderSystemMail } from "@/lib/mail/template";
import { notifyObservations } from "@/lib/notifications/observations";
import { readNotificationPreferences, setNotificationPreference } from "@/lib/notifications/preferences";
import { muteObservation, setObservationOn, type ObservationCaller } from "@/lib/observations/_mutes";
import { checkReputation } from "@/lib/reputation/transitions";
import { setStoredSetting } from "@/lib/settings/service";
import { suspendOrganization } from "@/lib/suspension";
import { resetDatabase, seedFixture, seedSystemOrganization, systemMailMessages, type Fixture } from "./fixtures";

vi.mock("@/lib/notifications/push/push", () => ({ sendPushAlert: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/mail/system", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mail/system")>();
  return { ...actual, sendSystemMail: vi.fn(actual.sendSystemMail) };
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-10-15T12:30:00Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);

let fixture: Fixture;
let caller: ObservationCaller;
let ada: { id: string; email: string };
let bob: { id: string; email: string };

async function addMember(role: OrgRole, name: string): Promise<{ id: string; email: string }> {
  const id = crypto.randomUUID();
  const email = `${name}-${id.slice(0, 8)}@owners.example`;
  await db.insert(users).values({ id, organizationId: fixture.organizationId, name, email });
  await db.insert(memberships).values({ id: newId("membership"), userId: id, organizationId: fixture.organizationId, role });
  return { id, email };
}

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture({ scopeToDomain: false });
  await seedSystemOrganization();
  ada = await addMember("owner", "ada");
  bob = await addMember("owner", "bob");
  await addMember("member", "cy");
  caller = { organizationId: fixture.organizationId, domainIds: [], actor: userActor(ada.id, "Ada"), userId: ada.id };
  vi.mocked(sendSystemMail).mockClear();
});
afterEach(() => {
  delete process.env.NOTIFICATION_ACCOUNT_TARGETED;
});

async function mailTo(email: string): Promise<string[]> {
  return (await systemMailMessages())
    .filter((message) => message.recipients.includes(email))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((message) => message.subject);
}

async function allMail(): Promise<string[]> {
  return (await systemMailMessages()).map((message) => message.subject);
}

/** Sensitive single-recipient sends at `when`, enough to be a targeted account. */
async function target(address: string, when: Date, count = 12, tags: string[] = []): Promise<void> {
  await db.insert(messages).values(
    Array.from({ length: count }, () => ({
      id: newId("message"),
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      apiKeyId: fixture.key.id,
      status: "delivered" as const,
      fromAddress: "hi@example.com",
      recipients: [address],
      subject: "Your code",
      envelope: { from: "hi@example.com", fromName: null, to: [address], cc: [], bcc: [], replyTo: [], headers: {}, attachmentCount: 0 },
      tags,
      bodyWithheld: "",
      createdAt: when,
      updatedAt: when,
    })),
  );
}

/** A tag that sent 60 a day for 14 days and nothing in the last one, beside an untagged send so the domain itself isn't quiet. */
async function quietTag(tag: string): Promise<void> {
  const rows = [];
  for (let back = 1; back <= 14; back += 1) {
    for (let i = 0; i < 60; i += 1) rows.push({ tags: [tag], when: at(-back * DAY - HOUR) });
  }
  rows.push({ tags: [], when: at(-HOUR) });
  await db.insert(messages).values(
    rows.map(({ tags, when }) => ({
      id: newId("message"),
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      status: "delivered" as const,
      fromAddress: "hi@example.com",
      recipients: ["someone@example.net"],
      subject: "Hello",
      envelope: { from: "hi@example.com", fromName: null, to: ["someone@example.net"], cc: [], bcc: [], replyTo: [], headers: {}, attachmentCount: 0 },
      tags,
      createdAt: when,
      updatedAt: when,
    })),
  );
}

/** Daily delivery rows: the last 7 days at `latestMs`, the 8 before at 40 seconds. */
async function deliveryHistory(latestMs: number): Promise<void> {
  await db.delete(domainDailyStats);
  await db.insert(domainDailyStats).values(
    Array.from({ length: 15 }, (_, back) => {
      const day = at(-back * DAY);
      return {
        organizationId: fixture.organizationId,
        domainId: fixture.domainId,
        day: day.toISOString().slice(0, 10),
        computedAt: day,
        deliveryWindowStart: new Date(day.getTime() - 7 * DAY),
        deliveredCount: 500,
        deliveryP90Ms: back < 7 ? latestMs : 40_000,
        volumeWindowStart: new Date(day.getTime() - 28 * DAY),
        hourlyVolume: Array.from({ length: 24 }, () => 0),
      };
    }),
  );
}

describe("each type sends by default and not again while it holds", () => {
  it("account_targeted", async () => {
    await target("jane@example.com", at(-HOUR));
    await notifyObservations(fixture.organizationId, NOW);
    await notifyObservations(fixture.organizationId, at(HOUR));

    for (const owner of [ada, bob]) expect(await mailTo(owner.email)).toEqual(["An address got 12 sensitive messages in 24 hours"]);
    expect(await allMail()).toHaveLength(2);

    // A second address while the first holds is the same condition, so it doesn't mail either.
    await target("kim@example.com", at(HOUR));
    await notifyObservations(fixture.organizationId, at(2 * HOUR));
    expect(await mailTo(ada.email)).toHaveLength(1);
  });

  it("tag_quiet", async () => {
    await quietTag("order-confirmation");
    await notifyObservations(fixture.organizationId, NOW);
    await notifyObservations(fixture.organizationId, at(HOUR));

    for (const owner of [ada, bob]) expect(await mailTo(owner.email)).toEqual(["The order-confirmation tag went quiet"]);
  });

  it("delivery_time", async () => {
    await deliveryHistory(240_000);
    await checkReputation(fixture.organizationId, NOW);
    await checkReputation(fixture.organizationId, at(HOUR));

    for (const owner of [ada, bob]) expect(await mailTo(owner.email)).toEqual(["Delivery on example.com is 6× slower than usual"]);
  });

  it("sends again once the condition clears and its window has passed, not before", async () => {
    await target("jane@example.com", at(-HOUR));
    await notifyObservations(fixture.organizationId, NOW);

    await db.delete(messages).where(eq(messages.organizationId, fixture.organizationId));
    await notifyObservations(fixture.organizationId, at(HOUR));
    const [row] = await db.select().from(notificationSends).where(eq(notificationSends.type, "account_targeted"));
    expect(row?.clearedAt).toEqual(at(HOUR));

    await target("jane@example.com", at(HOUR));
    await notifyObservations(fixture.organizationId, at(2 * HOUR));
    expect(await mailTo(ada.email)).toHaveLength(1);

    await notifyObservations(fixture.organizationId, at(25 * HOUR));
    await target("jane@example.com", at(25 * HOUR));
    await notifyObservations(fixture.organizationId, at(26 * HOUR));
    expect(await mailTo(ada.email)).toHaveLength(2);
  });

  it("clears delivery time once the domain is back to normal", async () => {
    await deliveryHistory(240_000);
    await checkReputation(fixture.organizationId, NOW);
    await deliveryHistory(45_000);
    await checkReputation(fixture.organizationId, at(HOUR));

    const [row] = await db.select().from(notificationSends).where(eq(notificationSends.type, "delivery_time"));
    expect(row).toMatchObject({ about: fixture.domainId, clearedAt: at(HOUR) });
  });
});

describe("an owner's choice", () => {
  it("turning a type off stops their copy and nobody else's", async () => {
    await setNotificationPreference(ada.id, "account_targeted", false);
    await target("jane@example.com", at(-HOUR));
    await notifyObservations(fixture.organizationId, NOW);

    expect(await mailTo(ada.email)).toEqual([]);
    expect(await mailTo(bob.email)).toEqual(["An address got 12 sensitive messages in 24 hours"]);
  });

  it("applies to the standing emails", async () => {
    await setNotificationPreference(ada.id, "standing_paused", false);
    await db.update(memberships).set({ role: "member" }).where(eq(memberships.userId, bob.id));
    await suspendOrganization(fixture.organizationId, { source: "manual", reason: "Terms review." }, workerActor("Test"), NOW);
    await checkReputation(fixture.organizationId, NOW);
    expect(await allMail()).toEqual([]);

    // Control: with the preference back on, the same change emails.
    await setNotificationPreference(ada.id, "standing_paused", true);
    await db.delete(reputationStates);
    await checkReputation(fixture.organizationId, at(HOUR));
    expect(await mailTo(ada.email)).toEqual(["Sending paused: Test"]);
  });

  it("claims nothing while every owner has it off, so turning it back on sends while it holds", async () => {
    await setNotificationPreference(ada.id, "account_targeted", false);
    await setNotificationPreference(bob.id, "account_targeted", false);
    await target("jane@example.com", at(-HOUR));
    await notifyObservations(fixture.organizationId, NOW);
    expect(await allMail()).toEqual([]);
    expect(await db.select().from(notificationSends)).toEqual([]);

    await setNotificationPreference(bob.id, "account_targeted", true);
    await notifyObservations(fixture.organizationId, at(HOUR));
    expect(await mailTo(bob.email)).toHaveLength(1);
    expect(await mailTo(ada.email)).toEqual([]);
  });

  it("stores only what differs from the default, and refuses a type that doesn't exist", async () => {
    await setNotificationPreference(ada.id, "tag_quiet", false);
    expect(await db.select().from(notificationPreferences)).toHaveLength(1);
    await setNotificationPreference(ada.id, "tag_quiet", true);
    expect(await db.select().from(notificationPreferences)).toEqual([]);
    await expect(setNotificationPreference(ada.id, "nonsense", false)).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("the operator's switch", () => {
  it("turning a type off stops every owner's copy", async () => {
    await setStoredSetting("notification_account_targeted", false);
    await target("jane@example.com", at(-HOUR));
    await notifyObservations(fixture.organizationId, NOW);
    expect(await allMail()).toEqual([]);

    // Control: back on, the same condition sends.
    await setStoredSetting("notification_account_targeted", true);
    await notifyObservations(fixture.organizationId, at(HOUR));
    expect(await allMail()).toHaveLength(2);
  });

  it("wins over an owner who has the type on, from the environment too", async () => {
    await setNotificationPreference(ada.id, "account_targeted", true);
    process.env.NOTIFICATION_ACCOUNT_TARGETED = "false";
    await target("jane@example.com", at(-HOUR));
    await notifyObservations(fixture.organizationId, NOW);
    expect(await allMail()).toEqual([]);

    const ownView = await readNotificationPreferences(ada.id);
    expect(ownView.find((preference) => preference.type === "account_targeted")).toMatchObject({ on: true, available: false });
  });

  it("observation types are off while the observations feature is", async () => {
    await setStoredSetting("observations", false);
    const view = await readNotificationPreferences(ada.id);
    expect(view.filter((preference) => !preference.available).map((preference) => preference.type)).toEqual(["account_targeted", "tag_quiet", "domain_spoofed"]);
  });
});

describe("the organization's mutes", () => {
  it("an observation turned off sends nothing, whatever the owners chose", async () => {
    await setNotificationPreference(ada.id, "account_targeted", true);
    await setObservationOn(caller, "account_targeted", false);
    await target("jane@example.com", at(-HOUR));
    await notifyObservations(fixture.organizationId, NOW);
    expect(await allMail()).toEqual([]);

    // Control: back on, it sends.
    await setObservationOn(caller, "account_targeted", true);
    await notifyObservations(fixture.organizationId, at(HOUR));
    expect(await allMail()).toHaveLength(2);
  });

  it("a tag mute drops that tag's mail and keeps another's", async () => {
    await quietTag("welcome");
    await quietTag("order-confirmation");
    await muteObservation(caller, "tag_quiet", { tag: "welcome" });
    await notifyObservations(fixture.organizationId, NOW);
    expect(await mailTo(ada.email)).toEqual(["The order-confirmation tag went quiet"]);
  });

  it("a key mute drops a targeted account sent with that key", async () => {
    await muteObservation(caller, "account_targeted", { keyId: fixture.key.id });
    await target("jane@example.com", at(-HOUR));
    await notifyObservations(fixture.organizationId, NOW);
    expect(await allMail()).toEqual([]);
  });
});

describe("every send", () => {
  it("links to notification settings, names no recipient address and is in the activity log", async () => {
    await target("jane@example.com", at(-HOUR));
    await notifyObservations(fixture.organizationId, NOW);

    const [call] = vi.mocked(sendSystemMail).mock.calls;
    expect(call?.[0].tags).toEqual(["account_targeted"]);
    const { html, text } = await renderSystemMail(call![0].email);
    expect(html).toContain("/user/settings#notifications");
    expect(text).toContain("Notification settings:");
    expect(html).not.toContain("jane@example.com");

    const rows = await db
      .select()
      .from(activity)
      .where(and(eq(activity.organizationId, fixture.organizationId), eq(activity.action, "notification.emailed")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subjectLabel: "An address got 12 sensitive messages in 24 hours", metadata: { type: "account_targeted", owners: 2, silenced: 0 } });
  });

  it("keeps the standing emails' tag", async () => {
    await suspendOrganization(fixture.organizationId, { source: "manual", reason: "Terms review." }, workerActor("Test"), NOW);
    await checkReputation(fixture.organizationId, NOW);
    expect(vi.mocked(sendSystemMail).mock.calls.map(([input]) => input.tags)).toEqual([["reputation-alert"], ["reputation-alert"]]);
  });
});
