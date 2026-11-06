/** Observations (#558): a targeted account, a tag gone quiet, mutes and the on/off switch. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, dmarcReportHosts, dmarcReports, memberships, messages, observationMutes, organizations, REPORT_HOST_ROW_ID, users } from "@/lib/db/schema";
import { createApiKey } from "@/lib/api/key-lifecycle";
import { userActor } from "@/lib/activity/record";
import { ROLES, type OrgRole } from "@/lib/auth/permissions";
import { idle } from "@/lib/dashboard/action-state";
import { readOverview } from "@/lib/dashboard/metrics";
import { newId } from "@/lib/ids";
import { currentWindow } from "@/lib/mail/digest/cadence";
import { readDigestSummary } from "@/lib/mail/digest/metrics";
import { runObservations } from "@/lib/observations/_runner";
import { listObservationSettings, muteObservation, setObservationOn, unmuteObservation, type ObservationCaller } from "@/lib/observations/_mutes";
import { defineObservation, type Finding } from "@/lib/observations/_types";
import { muteObservationAction, setObservationOnAction, unmuteObservationAction } from "@/app/(app)/settings/actions";
import SendingPage from "@/app/(app)/settings/sending/page";
import { addDomainKey, form, resetDatabase, seedFixture, type Fixture } from "./fixtures";

const sessionState = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@/lib/auth/session", async () => (await import("./fixtures")).adminSessionModule(sessionState));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {} }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/settings/sending",
}));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-10-15T12:30:00Z");

let fixture: Fixture;
let caller: ObservationCaller;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture({ scopeToDomain: false });
  caller = { organizationId: fixture.organizationId, domainIds: [], actor: userActor("usr_test", "Ada"), userId: null };
});

interface Seed {
  count: number;
  at: Date;
  to?: string | string[];
  reason?: string | null;
  tags?: string[];
  testMode?: boolean;
  apiKeyId?: string | null;
  domainId?: string;
}

/** `count` messages at `at`, sensitive with an empty reason unless `reason` says otherwise. */
async function seed({ count, at, to = "jane@example.com", reason = "", tags = [], testMode = false, apiKeyId = fixture.key.id, domainId = fixture.domainId }: Seed): Promise<void> {
  const recipients = Array.isArray(to) ? to : [to];
  const rows = Array.from({ length: count }, () => ({
    id: newId("message"),
    organizationId: fixture.organizationId,
    domainId,
    apiKeyId,
    status: "delivered" as const,
    fromAddress: "hi@example.com",
    recipients,
    subject: "Your code",
    envelope: { from: "hi@example.com", fromName: null, to: recipients, cc: [], bcc: [], replyTo: [], headers: {}, attachmentCount: 0 },
    tags,
    testMode,
    bodyWithheld: reason,
    createdAt: at,
    updatedAt: at,
  }));
  for (let i = 0; i < rows.length; i += 500) await db.insert(messages).values(rows.slice(i, i + 500));
}

const ago = (ms: number) => new Date(NOW.getTime() - ms);

async function observed(key: string, now = NOW) {
  return (await runObservations(fixture.organizationId, now)).filter((result) => result.key === key);
}

describe("account_targeted", () => {
  it("fires at 10 sensitive messages to one address, not at 9", async () => {
    await seed({ count: 9, at: ago(HOUR) });
    expect(await observed("account_targeted")).toEqual([]);

    await seed({ count: 1, at: ago(2 * HOUR) });
    const [result] = await observed("account_targeted");
    expect(result?.tone).toBe("warning");
    expect(result?.wording.title).toBe("jane@example.com got 10 sensitive messages in 24 hours");
    expect(result?.wording.links[0]?.href).toBe("/messages?address=jane%40example.com&sensitive=1&days=1");
  });

  it("counts the 24 hours up to now, not a moment more", async () => {
    await seed({ count: 9, at: ago(HOUR) });
    await seed({ count: 1, at: ago(DAY) });
    expect(await observed("account_targeted")).toEqual([]);

    await seed({ count: 1, at: ago(DAY - 1000) });
    expect(await observed("account_targeted")).toHaveLength(1);
  });

  it("leaves out test mode, messages with more than one recipient and mail that isn't sensitive", async () => {
    await seed({ count: 9, at: ago(HOUR) });
    await seed({ count: 5, at: ago(HOUR), testMode: true });
    await seed({ count: 5, at: ago(HOUR), to: ["jane@example.com", "bob@example.com"] });
    await seed({ count: 5, at: ago(HOUR), reason: null });
    expect(await observed("account_targeted")).toEqual([]);
  });

  it("uses the reason every message shares, and sensitive messages when they differ", async () => {
    await seed({ count: 12, at: ago(HOUR), reason: "a password reset link" });
    expect((await observed("account_targeted"))[0]?.wording.title).toBe("jane@example.com got 12 password reset links in 24 hours");

    await seed({ count: 1, at: ago(HOUR), reason: "a sign-in link" });
    expect((await observed("account_targeted"))[0]?.wording.title).toBe("jane@example.com got 13 sensitive messages in 24 hours");
  });

  it("collapses several addresses into one condition", async () => {
    for (const [address, count] of [["a@example.com", 20], ["b@example.com", 15], ["c@example.com", 12], ["d@example.com", 11], ["e@example.com", 3]] as const) {
      await seed({ count, at: ago(HOUR), to: address });
    }
    const results = await observed("account_targeted");
    expect(results).toHaveLength(1);
    expect(results[0]?.wording.title).toBe("4 addresses got 10 or more sensitive messages in 24 hours");
    expect(results[0]?.wording.body).toBe("a@example.com (20), b@example.com (15), c@example.com (12) and 1 more. Someone may be targeting these accounts.");
  });

  it("stays inside the organization", async () => {
    await seed({ count: 12, at: ago(HOUR) });
    const other = await seedFixture();
    expect((await runObservations(other.organizationId, NOW)).filter((result) => result.key === "account_targeted")).toEqual([]);
  });
});

/** `perDay` live messages a day for each of the 14 baseline days, and `lastDay` in the last 24 hours. */
async function seedTag(tag: string, perDay: number | number[], lastDay = 0, testMode = false, domainId = fixture.domainId): Promise<void> {
  for (let back = 1; back <= 14; back += 1) {
    const count = Array.isArray(perDay) ? (perDay[back - 1] ?? 0) : perDay;
    if (count > 0) await seed({ count, at: ago(back * DAY + HOUR), tags: [tag], reason: null, testMode, domainId });
  }
  if (lastDay > 0) await seed({ count: lastDay, at: ago(HOUR), tags: [tag], reason: null, testMode, domainId });
}

/** An untagged live send in the last day, so the domain itself hasn't gone quiet. */
const keepSending = (domainId = fixture.domainId) => seed({ count: 1, at: ago(HOUR), reason: null, domainId });

describe("tag_quiet", () => {
  it("fires for a tag that sent every baseline day and nothing in the last one", async () => {
    await seedTag("order-confirmation", 60);
    await keepSending();
    const [result] = await observed("tag_quiet");
    expect(result?.tone).toBe("info");
    expect(result?.wording.title).toBe("The order-confirmation tag went quiet");
    expect(result?.wording.body).toBe("None sent in the last day, against about 60 a day over the previous 14 days.");
  });

  it("follows the domain rule: a day off in the baseline, a low average or any send in the last day keeps it quiet", async () => {
    await seedTag("gap", [60, 60, 60, 0, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60]);
    await seedTag("small", 40);
    await seedTag("still-sending", 60, 1);
    expect(await observed("tag_quiet")).toEqual([]);
  });

  it("leaves out a tag only used in test mode", async () => {
    await seedTag("sandbox", 60, 0, true);
    await keepSending();
    expect(await observed("tag_quiet")).toEqual([]);
  });

  it("leaves out a tag whose every domain went quiet too, since the domain's condition covers it", async () => {
    const second = await addDomainKey(fixture);
    await seedTag("order-confirmation", 60);
    await keepSending(second.domainId);
    expect(await observed("tag_quiet")).toEqual([]);
  });

  it("keeps a tag that also went out from a domain still sending", async () => {
    const second = await addDomainKey(fixture);
    await seedTag("order-confirmation", 30);
    await seedTag("order-confirmation", 30, 0, false, second.domainId);
    await keepSending(second.domainId);
    expect((await observed("tag_quiet")).map((result) => result.wording.title)).toEqual(["The order-confirmation tag went quiet"]);
  });
});

describe("mutes", () => {
  it("a tag mute drops tag_quiet for that tag only", async () => {
    await seedTag("order-confirmation", 60);
    await seedTag("welcome", 60);
    await keepSending();
    await muteObservation(caller, "tag_quiet", { tag: "welcome" });
    expect((await observed("tag_quiet")).map((result) => result.wording.title)).toEqual(["The order-confirmation tag went quiet"]);
  });

  it("a key mute leaves that key's messages out of account_targeted", async () => {
    const other = await createApiKey({ organizationId: fixture.organizationId, name: "Signup form", mode: "live", domainIds: [] });
    await seed({ count: 6, at: ago(HOUR) });
    await seed({ count: 6, at: ago(HOUR), apiKeyId: other.key.id });

    const [before] = await observed("account_targeted");
    expect(before?.mute.keys.map((key) => key.name).sort()).toEqual(["Signup form", "test"]);

    await muteObservation(caller, "account_targeted", { keyId: other.key.id });
    expect(await observed("account_targeted")).toEqual([]);
  });

  it("a tag mute leaves messages carrying that tag out of account_targeted", async () => {
    await seed({ count: 6, at: ago(HOUR), tags: ["password-reset"] });
    await seed({ count: 6, at: ago(HOUR), tags: ["login"] });
    expect((await observed("account_targeted"))[0]?.mute.tags).toEqual(["login", "password-reset"]);

    await muteObservation(caller, "account_targeted", { tag: "login" });
    expect(await observed("account_targeted")).toEqual([]);
  });

  it("refuses a key mute on an observation only a tag can mute, and another organization's key", async () => {
    await expect(muteObservation(caller, "tag_quiet", { keyId: fixture.key.id })).rejects.toMatchObject({ code: "validation_failed" });
    const other = await seedFixture();
    await expect(muteObservation(caller, "account_targeted", { keyId: other.key.id })).rejects.toMatchObject({ code: "not_found" });
  });

  it("records muting and unmuting in the activity log, once", async () => {
    await muteObservation(caller, "tag_quiet", { tag: "welcome" });
    await muteObservation(caller, "tag_quiet", { tag: "welcome" });
    await muteObservation(caller, "account_targeted", { keyId: fixture.key.id });
    const [setting] = (await listObservationSettings(fixture.organizationId)).filter((row) => row.key === "tag_quiet");
    await unmuteObservation(caller, setting!.mutes[0]!.id);

    const rows = await db
      .select({ action: activity.action, subject: activity.subjectLabel })
      .from(activity)
      .where(eq(activity.organizationId, fixture.organizationId))
      .orderBy(activity.createdAt);
    expect(rows).toEqual([
      { action: "settings.observation.muted", subject: "Tag gone quiet for the welcome tag" },
      { action: "settings.observation.muted", subject: "Targeted account for key test" },
      { action: "settings.observation.unmuted", subject: "Tag gone quiet for the welcome tag" },
    ]);
  });
});

describe("the on/off switch", () => {
  it("is on with no row, and off drops the observation from the runner, the overview and the digest", async () => {
    const window = currentWindow("daily", NOW);
    const before = new Date(window.until.getTime() - HOUR);
    await seed({ count: 12, at: before });

    const settings = await listObservationSettings(fixture.organizationId);
    expect(settings.every((row) => row.on)).toBe(true);
    expect((await runObservations(fixture.organizationId, window.until)).map((result) => result.key)).toContain("account_targeted");
    const overview = await readOverview(fixture.organizationId, 1, "UTC", window.until);
    expect(overview.conditions.find((condition) => condition.key === "account_targeted")?.mute).toMatchObject({ observation: "account_targeted", title: "Targeted account" });
    expect((await readDigestSummary(window))?.attention.observations.map((row) => row.key)).toEqual(["account_targeted"]);

    await setObservationOn(caller, "account_targeted", false);
    expect((await listObservationSettings(fixture.organizationId)).find((row) => row.key === "account_targeted")?.on).toBe(false);
    expect((await runObservations(fixture.organizationId, window.until)).map((result) => result.key)).not.toContain("account_targeted");
    expect((await readOverview(fixture.organizationId, 1, "UTC", window.until)).conditions.map((condition) => condition.key)).not.toContain("account_targeted");
    expect((await readDigestSummary(window))?.attention.observations).toEqual([]);

    await setObservationOn(caller, "account_targeted", true);
    expect((await runObservations(fixture.organizationId, window.until)).map((result) => result.key)).toContain("account_targeted");
  });

  it("records turning off and back on, and nothing for a switch already in place", async () => {
    await setObservationOn(caller, "tag_quiet", true);
    await setObservationOn(caller, "tag_quiet", false);
    await setObservationOn(caller, "tag_quiet", false);
    await setObservationOn(caller, "tag_quiet", true);
    const rows = await db.select({ action: activity.action }).from(activity).where(eq(activity.organizationId, fixture.organizationId)).orderBy(activity.createdAt);
    expect(rows.map((row) => row.action)).toEqual(["settings.observation.turned_off", "settings.observation.turned_on"]);
  });

  it("ignores rows for an observation no file defines, and keeps them", async () => {
    await db.insert(observationMutes).values({ id: newId("observationMute"), organizationId: fixture.organizationId, key: "removed_observation" });
    expect((await listObservationSettings(fixture.organizationId)).map((row) => row.key)).not.toContain("removed_observation");
    await runObservations(fixture.organizationId, NOW);
    expect(await db.select().from(observationMutes).where(eq(observationMutes.key, "removed_observation"))).toHaveLength(1);
  });
});

describe("the runner", () => {
  const fake = defineObservation<"fake", Finding & { label: string }>({
    key: "fake",
    title: "Fake",
    description: "For tests.",
    tone: "info",
    mutableBy: ["tag", "key"],
    example: { label: "a", tags: ["a"], keyIds: [] },
    evaluate: async ({ mutes }) => [
      { label: `a:${mutes.tags.join(",")}`, tags: ["a"], keyIds: [] },
      { label: "b", tags: ["b"], keyIds: [] },
      { label: "k", tags: [], keyIds: [fixture.key.id] },
    ],
    condition: ({ label }) => ({ title: label, body: label, links: [] }),
    digestLine: ({ label }) => ({ text: label, path: "/" }),
  });
  const titles = async () => (await runObservations(fixture.organizationId, NOW, [fake])).map((result) => result.wording.title);
  const mute = (values: { tag?: string; apiKeyId?: string }) =>
    db.insert(observationMutes).values({ id: newId("observationMute"), organizationId: fixture.organizationId, key: "fake", ...values });

  it("hands an observation its mutes and drops findings a tag or key mute covers", async () => {
    expect(await titles()).toEqual(["a:", "b", "k"]);
    await mute({ tag: "b" });
    expect(await titles()).toEqual(["a:b", "k"]);
    await db.delete(observationMutes);
    await mute({ apiKeyId: fixture.key.id });
    expect(await titles()).toEqual(["a:", "b"]);
  });

  it("runs nothing for an observation that's off", async () => {
    await mute({});
    expect(await titles()).toEqual([]);
  });

  it("leaves out an observation that throws", async () => {
    const broken = { ...fake, key: "broken", evaluate: async () => Promise.reject(new Error("boom")) };
    expect((await runObservations(fixture.organizationId, NOW, [broken, fake])).map((result) => result.key)).toEqual(["fake", "fake", "fake"]);
  });
});

describe("dashboard actions", () => {
  async function signIn(role: OrgRole): Promise<string> {
    const userId = crypto.randomUUID();
    await db.insert(users).values({ id: userId, organizationId: fixture.organizationId, name: "Ada", email: `${userId}@example.com` });
    await db.insert(memberships).values({ id: newId("membership"), userId, organizationId: fixture.organizationId, role });
    sessionState.userId = userId;
    return userId;
  }

  it("mutes from the overview card, unmutes from settings and turns an observation off and on", async () => {
    const userId = await signIn(ROLES.OWNER);

    expect(await muteObservationAction(idle, form({ observation: "account_targeted", keyId: fixture.key.id }))).toEqual({
      status: "ok",
      message: "Targeted account muted for key test.",
    });
    expect(await muteObservationAction(idle, form({ observation: "tag_quiet", tag: "welcome" }))).toEqual({
      status: "ok",
      message: "Tag gone quiet muted for the welcome tag.",
    });
    const [row] = await db.select().from(observationMutes).where(and(eq(observationMutes.key, "tag_quiet"), eq(observationMutes.tag, "welcome")));
    expect(row?.createdBy).toBe(userId);

    expect(await unmuteObservationAction(idle, form({ muteId: row!.id }))).toEqual({ status: "ok", message: "Unmuted." });
    expect(await setObservationOnAction(idle, form({ observation: "tag_quiet", on: "false" }))).toEqual({ status: "ok", message: "Tag gone quiet turned off." });
    expect(await setObservationOnAction(idle, form({ observation: "tag_quiet", on: "true" }))).toEqual({ status: "ok", message: "Tag gone quiet turned on." });

    const actions = await db.select({ action: activity.action, actor: activity.actorLabel }).from(activity).where(eq(activity.organizationId, fixture.organizationId)).orderBy(activity.createdAt);
    expect(actions.map((entry) => entry.action)).toEqual([
      "settings.observation.muted",
      "settings.observation.muted",
      "settings.observation.unmuted",
      "settings.observation.turned_off",
      "settings.observation.turned_on",
    ]);
    expect(new Set(actions.map((entry) => entry.actor))).toEqual(new Set(["Ada"]));
  });

  it("lists every observation in settings with its switch and its mutes", async () => {
    await signIn(ROLES.OWNER);
    await muteObservation(caller, "tag_quiet", { tag: "welcome" });
    await setObservationOn(caller, "account_targeted", false);
    const html = renderToStaticMarkup(await SendingPage()).replace(/&#x27;/g, "'");

    expect(html).toContain(">Observations<");
    expect(html).toContain("Targeted account");
    expect(html).toContain("One address gets 10 or more sensitive messages in 24 hours.");
    expect(html).toContain("Tag gone quiet");
    expect(html.replace(/<[^>]+>/g, "")).toContain("Muted for the welcome tag");
    expect(html).toContain("Unmute");
    expect(html).toMatch(/aria-label="Targeted account"[^>]*data-state="unchecked"|data-state="unchecked"[^>]*aria-label="Targeted account"/);
  });

  it("lists Sending as your domain while the organization has DMARC reports on, whether or not the report host is receiving", async () => {
    await signIn(ROLES.OWNER);
    await db.insert(dmarcReportHosts).values({ id: REPORT_HOST_ROW_ID, host: "reports.example.net", providerId: fixture.providerId, verifiedAt: null });
    await db.insert(dmarcReports).values({
      id: newId("dmarcReport"),
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      reporter: "google.com",
      reportId: "stored",
      beginsAt: new Date(Date.now() - 2 * DAY),
      endsAt: new Date(Date.now() - DAY),
      policy: { domain: "example.com", p: "none", sp: null, pct: 100, adkim: null, aspf: null },
      messageCount: 12,
    });
    const listed = async () => renderToStaticMarkup(await SendingPage()).replace(/&#x27;/g, "'");

    const on = await listed();
    expect(on).toContain("Sending as your domain");
    expect(on).toContain("An admin hasn't set up DMARC reports on this install.");

    await db.update(organizations).set({ dmarcReportsEnabled: false }).where(eq(organizations.id, fixture.organizationId));
    expect(await listed()).not.toContain("Sending as your domain");
  });

  it("answers an unknown observation with what's wrong", async () => {
    await signIn(ROLES.OWNER);
    expect(await setObservationOnAction(idle, form({ observation: "nope", on: "false" }))).toEqual({ status: "error", message: "No observation named nope.", field: "observation" });
  });

  it("refuses a member", async () => {
    await signIn(ROLES.MEMBER);
    await expect(muteObservationAction(idle, form({ observation: "tag_quiet", tag: "welcome" }))).rejects.toMatchObject({ code: "insufficient_role" });
    await expect(setObservationOnAction(idle, form({ observation: "tag_quiet", on: "false" }))).rejects.toMatchObject({ code: "insufficient_role" });
    expect(await db.select().from(observationMutes)).toEqual([]);
  });
});
