import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { activity, domains, messages, type MessageStatus } from "@/lib/db/schema";
import { adminActor } from "@/lib/activity/record";
import { newId } from "@/lib/ids";
import { brand } from "@/lib/brand";
import { readStallLines } from "@/lib/domains/stall";
import { readDomainReputation } from "@/lib/reputation/read";
import { readSettings, setSetting } from "@/lib/settings/values";
import { SettingsSections } from "@/app/(app)/admin/settings/general/settings-sections";
import type { DomainDetailData } from "@/lib/dashboard/views/domains";
import { ReputationSection } from "@/app/(app)/domains/[id]/reputation/reputation-screen";
import { StallGuardLoop } from "@/worker/stall-guard";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

vi.mock("@/lib/notifications/push/push", () => ({ sendPushAlert: vi.fn().mockResolvedValue(undefined) }));

const ADMIN = adminActor("usr_admin", "Admin");

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function insertMessages(status: MessageStatus, count: number, createdAt: Date): Promise<void> {
  for (let i = 0; i < count; i++) {
    await db.insert(messages).values({
      id: newId("message"),
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      status,
      fromAddress: "hi@example.com",
      recipients: ["person@example.net"],
      subject: "Hello",
      envelope: { from: "hi@example.com", fromName: null, to: ["person@example.net"], cc: [], bcc: [], replyTo: [], headers: {}, attachmentCount: 0 },
      tags: [],
      testMode: false,
      createdAt,
    });
  }
}

/** 2% bounces on 100 resolved messages: under the default 2.5% line, over a 1.5% one. */
async function twoPercentBounces(): Promise<void> {
  const now = await dbNow();
  await insertMessages("bounced", 2, now);
  await insertMessages("delivered", 98, now);
}

async function sweep(): Promise<Date | null> {
  await new StallGuardLoop({ intervalMs: 60_000, batchSize: 10, recheckAfterMs: 0 }).tick();
  const [row] = await db.select({ stalledAt: domains.stalledAt }).from(domains).where(eq(domains.id, fixture.domainId));
  return row?.stalledAt ?? null;
}

describe("a tightened stall line", () => {
  it("[control] the default line leaves a 2% bounce rate sending", async () => {
    await twoPercentBounces();
    expect(await sweep()).toBeNull();
  });

  it("stalls a domain the default wouldn't", async () => {
    await setSetting("stall_bounce_percent", 1.5, ADMIN);
    await twoPercentBounces();
    expect(await sweep()).not.toBeNull();
  });

  it("puts the same domain's standing at the stall guard's next check", async () => {
    await twoPercentBounces();
    const before = await readDomainReputation(fixture.organizationId, fixture.domainId, await dbNow());
    expect(before?.findings.map((finding) => finding.kind)).not.toContain("stall_pending");

    await setSetting("stall_bounce_percent", 1.5, ADMIN);
    const after = await readDomainReputation(fixture.organizationId, fixture.domainId, await dbNow());
    expect(after?.findings.map((finding) => finding.kind)).toContain("stall_pending");
  });

  it("stalls on a lower bounce count below the rate floor", async () => {
    const now = await dbNow();
    await insertMessages("bounced", 2, now);
    await insertMessages("delivered", 10, now);
    expect(await sweep()).toBeNull();

    await setSetting("stall_bounce_count", 2, ADMIN);
    expect(await sweep()).not.toBeNull();
  });
});

describe("a looser value", () => {
  it("[control] the default and anything tighter are accepted", async () => {
    await setSetting("stall_bounce_percent", 2.5, ADMIN);
    await setSetting("stall_bounce_percent", 2.4, ADMIN);
    await setSetting("stall_complaint_percent", 0.01, ADMIN);
    await setSetting("stall_bounce_count", 1, ADMIN);
    await setSetting("stall_count_volume_floor", 1, ADMIN);
    expect(await readStallLines()).toMatchObject({
      bounce: { stall: 0.024, count: 1 },
      complaint: { stall: 0.0001 },
      countVolumeFloor: 1,
    });
  });

  it.each([
    ["stall_bounce_percent", 2.6, "Pause bounce rate can't be looser than its default, 2.5%."],
    ["stall_complaint_percent", 0.06, "Pause complaint rate can't be looser than its default, 0.05%."],
    ["stall_bounce_count", 4, "Pause bounce count can't be looser than its default, 3 bounces."],
    ["stall_count_volume_floor", 11, "Count guard floor can't be looser than its default, 10 messages."],
  ] as const)("refuses %s at %s", async (key, value, message) => {
    await expect(setSetting(key, value, ADMIN)).rejects.toMatchObject({ code: "validation_failed", message });
  });

  it("refuses a value off the step or under the floor", async () => {
    await expect(setSetting("stall_bounce_percent", 1.55, ADMIN)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(setSetting("stall_bounce_percent", 0.4, ADMIN)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(setSetting("stall_bounce_count", 0, ADMIN)).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("skips a looser value from the environment, and takes a tighter one", async () => {
    vi.stubEnv("STALL_BOUNCE_PERCENT", "5");
    expect((await readStallLines()).bounce.stall).toBe(0.025);
    vi.stubEnv("STALL_BOUNCE_PERCENT", "1.5");
    expect((await readStallLines()).bounce.stall).toBe(0.015);
  });

  it("records a change in the service's activity log", async () => {
    await setSetting("stall_complaint_percent", 0.03, ADMIN);
    const rows = await db.select().from(activity).where(eq(activity.appliesTo, "stall_complaint_percent"));
    expect(rows.map((row) => [row.action, row.metadata])).toEqual([
      ["system.setting.changed", { setting: "stall_complaint_percent", from: 0.05, to: 0.03 }],
    ]);
  });
});

describe("Admin settings → Reputation", () => {
  it("groups the lines under Reputation, with each default as its limit", async () => {
    const html = renderToStaticMarkup(createElement(SettingsSections, { settings: await readSettings(), configFile: "pouch.yml" })).replace(/&#x27;/g, "'");
    expect(html).toContain("Reputation");
    expect(html).toContain("0.5% to 2.5%. The default, 2.5%, is the highest.");
    expect(html).toContain("1 to 10 messages. The default, 10 messages, is the highest.");
    expect(html).toContain("7 to 730 days.</");
  });
});

describe("the reputation bars", () => {
  async function markup(): Promise<string> {
    const reputation = await readDomainReputation(fixture.organizationId, fixture.domainId, await dbNow());
    const domain = { name: "example.com", stall: null } as unknown as DomainDetailData;
    return renderToStaticMarkup(createElement(ReputationSection, { domain, reputation, dmarcReports: null, suppressions: [], zone: "UTC" }));
  }

  it("[control] mark the default line", async () => {
    await twoPercentBounces();
    expect(await markup()).toContain(`${brand.name} 2.5%`);
  });

  it("mark the configured line", async () => {
    await setSetting("stall_bounce_percent", 1.5, ADMIN);
    await setSetting("stall_complaint_percent", 0.02, ADMIN);
    await twoPercentBounces();
    const html = await markup();
    expect(html).toContain(`${brand.name} 1.5%`);
    expect(html).toContain(`${brand.name} 0.02%`);
    expect(html).not.toContain(`${brand.name} 2.5%`);
  });
});
