/** DMARC reports (#298): the report host, ingest, the rua, standing, the observation, retention and the API. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, dmarcDomainTokens, dmarcReportHosts, dmarcReportRecords, dmarcReports, domains, inboundMessages, memberships, organizations, providers, REPORT_HOST_ROW_ID, users } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { encryptCredentials } from "@/lib/providers";
import { GET as listReports } from "@/app/api/v1/domains/[id]/dmarc_reports/route";
import { GET as readDomainRoute } from "@/app/api/v1/domains/[id]/route";
import { adminActor, userActor } from "@/lib/activity/record";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { REPORT_ROUTE_ID, setReportHost, verifyReportHost } from "@/lib/dmarc/host";
import { ingestDmarcReport } from "@/lib/dmarc/ingest";
import { checkDmarcPolicyReady } from "@/lib/dmarc/ready";
import { dmarcVerdict, READY_DAYS, readDmarcPanel, readHealthyStreak, readQuarantineRecommendation } from "@/lib/dmarc/read";
import { purgeExpiredReports } from "@/lib/dmarc/retention";
import { setDmarcReportsEnabled } from "@/lib/dmarc/switch";
import { setSetting } from "@/lib/settings/values";
import { resetDnsCheckCache } from "@/lib/domains/dns-check";
import { receiveProviderMail } from "@/lib/inbound/ingest";
import { domainSpoofed, SPOOFED_MIN_MESSAGES } from "@/lib/observations/domain-spoofed";
import { runObservations } from "@/lib/observations/_runner";
import type { ProposedDnsRecord, ReceivedMail } from "@/lib/providers/adapters/types";
import { readDomainStanding } from "@/lib/reputation/read";
import { DMARC_FAILING_MIN_MESSAGES, DMARC_FAILING_WATCH_SHARE } from "@/lib/reputation/standing";
import { epoch, reportMessage, reportXml, zipped, type ReportRow } from "../dmarc-report-fixtures";
import { addDomainKey, apiRequest, resetDatabase, routeContext, seedFixture, seedSystemOrganization, systemMailMessages, type Fixture } from "./fixtures";

const zone = vi.hoisted(() => new Map<string, string[]>());
vi.mock("node:dns/promises", () => {
  class Resolver {
    setServers() {}
    cancel() {}
    async resolveTxt(name: string): Promise<string[][]> {
      const records = zone.get(name);
      if (!records) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return records.map((record) => [record]);
    }
  }
  return { Resolver };
});

const HOST = "reports.example.net";
const NOW = new Date();
const DAY = 86_400_000;

const sesRecords: ProposedDnsRecord[] = [
  { type: "CNAME", name: "abc._domainkey.example.com", value: "abc.dkim.amazonses.com", required: true },
  { type: "TXT", name: "mail.example.com", value: "v=spf1 include:amazonses.com ~all", required: false },
];

const providerRow: ReportRow = {
  ip: "54.240.1.1",
  count: 0,
  dkim: "pass",
  spf: "pass",
  envelopeFrom: "mail.example.com",
  dkimResults: [{ domain: "example.com", selector: "abc", result: "pass" }],
  spfResults: [{ domain: "mail.example.com", result: "pass" }],
};

const spoofRow: ReportRow = {
  ip: "203.0.113.9",
  count: 0,
  dkim: "fail",
  spf: "fail",
  envelopeFrom: "spoof.example.net",
  dkimResults: [{ domain: "spoof.example.net", selector: "s1", result: "pass" }],
  spfResults: [{ domain: "spoof.example.net", result: "pass" }],
};

let fixture: Fixture;

async function domainRow(id = fixture.domainId) {
  const [row] = await db.select().from(domains).where(eq(domains.id, id));
  return row!;
}

/** A report message as a provider stores it: zipped XML, one attachment. */
function message(options: Parameters<typeof reportXml>[0] = {}, to = `tok@${HOST}`): Buffer {
  return reportMessage(zipped(reportXml(options)), { to });
}

async function setHost(verified = true, providerId = fixture.providerId): Promise<void> {
  await db
    .insert(dmarcReportHosts)
    .values({ id: REPORT_HOST_ROW_ID, host: HOST, providerId, route: {}, verifiedAt: verified ? NOW : null })
    .onConflictDoUpdate({ target: dmarcReportHosts.id, set: { host: HOST, providerId, verifiedAt: verified ? NOW : null } });
}

async function token(domainId = fixture.domainId): Promise<string> {
  const [row] = await db.insert(dmarcDomainTokens).values({ domainId, organizationId: fixture.organizationId, token: `tok${domainId.slice(-6)}` }).returning();
  return row!.token;
}

function stored(raw: Buffer, recipients: string[]): ReceivedMail & { discarded: () => boolean } {
  let discarded = false;
  return {
    domainId: REPORT_ROUTE_ID,
    providerMessageId: "ses-message-1",
    recipients,
    verdicts: { spam: "pass", virus: "pass", spf: "pass", dkim: "pass", dmarc: "pass" },
    read: async () => raw,
    discard: async () => {
      discarded = true;
    },
    discarded: () => discarded,
  };
}

/** One report per call, ending `daysAgo` before NOW, with `provider` and `spoofed` message counts. */
async function seedReport({ provider = 0, providerFailing = 0, spoofed = 0, daysAgo = 1, reportId = `r${Math.random()}` }) {
  const rows: ReportRow[] = [];
  if (provider > 0) rows.push({ ...providerRow, count: provider });
  if (providerFailing > 0) rows.push({ ...providerRow, ip: "54.240.1.2", count: providerFailing, dkim: "fail", spf: "fail", dkimResults: [{ domain: "example.com", selector: "abc", result: "fail" }] });
  if (spoofed > 0) rows.push({ ...spoofRow, count: spoofed });
  const end = epoch(new Date(NOW.getTime() - daysAgo * DAY));
  const outcome = await ingestDmarcReport(await domainRow(), reportMessage(zipped(reportXml({ rows, end, reportId }))));
  expect(outcome.outcome).toBe("stored");
}

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  resetDnsCheckCache();
  zone.clear();
  fixture = await seedFixture({ scopeToDomain: false });
  await db.update(domains).set({ dnsRecords: sesRecords }).where(eq(domains.id, fixture.domainId));
});

describe("ingesting a report", () => {
  it("stores each row for the domain, classified, and counts a second copy as a duplicate", async () => {
    const raw = message({ rows: [{ ...providerRow, count: 120 }, { ...spoofRow, count: 7 }] });
    const first = await ingestDmarcReport(await domainRow(), raw);
    expect(first).toMatchObject({ outcome: "stored", records: 2 });

    const records = await db.select().from(dmarcReportRecords);
    expect(records.map((row) => [row.sourceIp, row.count, row.origin]).sort()).toEqual([
      ["203.0.113.9", 7, "unauthenticated"],
      ["54.240.1.1", 120, "provider"],
    ]);
    const [report] = await db.select().from(dmarcReports);
    expect(report).toMatchObject({ domainId: fixture.domainId, reporter: "google.com", messageCount: 127 });

    expect(await ingestDmarcReport(await domainRow(), raw)).toEqual({ outcome: "duplicate" });
    expect(await db.select().from(dmarcReports)).toHaveLength(1);
    expect(await db.select().from(dmarcReportRecords)).toHaveLength(2);
  });

  it("rejects a report about another domain and keeps only rows from this one", async () => {
    const elsewhere = await ingestDmarcReport(await domainRow(), message({ domain: "other.example.org" }));
    expect(elsewhere).toMatchObject({ outcome: "rejected", reason: "the report is about other.example.org" });

    const mixed = await ingestDmarcReport(
      await domainRow(),
      message({ rows: [{ ...providerRow, count: 3 }, { ...spoofRow, count: 4, headerFrom: "shop.example.com" }] }),
    );
    expect(mixed).toMatchObject({ outcome: "stored", records: 1 });
    expect(await db.select().from(dmarcReports)).toHaveLength(1);
  });

  it("rejects a message with nothing that reads as a report", async () => {
    const outcome = await ingestDmarcReport(await domainRow(), reportMessage(Buffer.from("not xml at all"), { filename: "report.xml", contentType: "text/xml" }));
    expect(outcome.outcome).toBe("rejected");
    expect(await db.select().from(dmarcReports)).toHaveLength(0);
  });
});

describe("report mail on the host's route", () => {
  it("goes to the domain its token names, never to inbound, and the provider's copy is deleted", async () => {
    await setHost();
    const own = await token();
    const mail = stored(message({}, `${own}@${HOST}`), [`${own}@${HOST}`, `nobody@${HOST}`]);

    expect(await receiveProviderMail(fixture.providerId, mail)).toEqual({ accepted: 1, duplicates: 0 });
    expect(mail.discarded()).toBe(true);
    expect(await db.select().from(dmarcReports)).toHaveLength(1);
    expect(await db.select().from(inboundMessages)).toHaveLength(0);
  });

  it("reads the To header when the envelope is gone, as on a replay", async () => {
    await setHost();
    const own = await token();
    expect(await receiveProviderMail(fixture.providerId, stored(message({}, `${own}@${HOST}`), []))).toEqual({ accepted: 1, duplicates: 0 });
  });

  it("drops mail for an unknown token, from another provider, or that the scan failed", async () => {
    await setHost();
    const own = await token();

    const unknown = stored(message({}, `nobody@${HOST}`), [`nobody@${HOST}`]);
    expect(await receiveProviderMail(fixture.providerId, unknown)).toEqual({ accepted: 0, duplicates: 0 });
    expect(unknown.discarded()).toBe(true);

    const foreign = stored(message({}, `${own}@${HOST}`), [`${own}@${HOST}`]);
    expect(await receiveProviderMail("pac_someoneelse", foreign)).toEqual({ accepted: 0, duplicates: 0 });
    expect(foreign.discarded()).toBe(true);

    const forged = { ...stored(message({}, `${own}@${HOST}`), [`${own}@${HOST}`]), verdicts: { spam: "pass", virus: "pass", spf: "fail", dkim: "fail", dmarc: "fail" } };
    expect(await receiveProviderMail(fixture.providerId, forged)).toEqual({ accepted: 0, duplicates: 0 });

    expect(await db.select().from(dmarcReports)).toHaveLength(0);
  });
});

describe("the report host", () => {
  it("verifies once its authorization record is published, and stops when it's gone", async () => {
    await setHost(false);
    expect((await verifyReportHost())?.verified).toBe(false);

    zone.set(`*._report._dmarc.${HOST}`, ["v=DMARC1"]);
    resetDnsCheckCache();
    expect((await verifyReportHost())?.verified).toBe(true);
    const [row] = await db.select().from(dmarcReportHosts);
    expect(row?.verifiedAt).not.toBeNull();

    zone.clear();
    resetDnsCheckCache();
    expect((await verifyReportHost())?.verified).toBe(false);
    const [after] = await db.select().from(dmarcReportHosts);
    expect(after?.verifiedAt).toBeNull();
  });

  it("refuses an organization's provider, and a shared one that can't route received mail through its API", async () => {
    await expect(setReportHost({ host: HOST, providerId: fixture.providerId })).rejects.toMatchObject({ code: "not_found" });

    const shared = newId("provider");
    await db.insert(providers).values({ id: shared, organizationId: null, shared: true, adapter: "mock", name: "shared mock", credentials: encryptCredentials({ serverToken: "t" }), settings: {}, concurrency: 4 });
    await expect(setReportHost({ host: HOST, providerId: shared })).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(await db.select().from(dmarcReportHosts)).toHaveLength(0);
  });
});

describe("the rua in the domain's recommended record", () => {
  const dmarcValue = async (): Promise<string | undefined> => {
    const response = await readDomainRoute(apiRequest(fixture.secret, `/v1/domains/${fixture.domainId}`), routeContext(fixture.domainId));
    const body = (await response.json()) as { dns_records: { name: string; value: string }[] };
    return body.dns_records.find((record) => record.name === "_dmarc.example.com")?.value;
  };

  it("carries the domain's own address once the host is verified, and the same one on every read", async () => {
    expect(await dmarcValue()).toBe("v=DMARC1; p=none;");
    await setHost(false);
    expect(await dmarcValue()).toBe("v=DMARC1; p=none;");

    await setHost(true);
    const value = await dmarcValue();
    const [row] = await db.select().from(dmarcDomainTokens).where(eq(dmarcDomainTokens.domainId, fixture.domainId));
    expect(value).toBe(`v=DMARC1; p=none; rua=mailto:${row!.token}@${HOST};`);
    expect(row!.token).toMatch(/^[0-9a-f]{24}$/);
    expect(await dmarcValue()).toBe(value);
  });

  it("leaves the address out for an organization that turned reports off, and logs the change once", async () => {
    await setHost(true);
    const caller = { organizationId: fixture.organizationId, actor: userActor("usr_test", "Ada") };
    await setDmarcReportsEnabled(caller, false);
    await setDmarcReportsEnabled(caller, false);
    expect(await dmarcValue()).toBe("v=DMARC1; p=none;");

    const rows = await db.select({ action: activity.action }).from(activity).where(eq(activity.organizationId, fixture.organizationId));
    expect(rows.map((row) => row.action)).toEqual(["settings.dmarc_reports.turned_off"]);
  });
});

describe("standing and the observation", () => {
  it("watches a domain whose own mail fails DMARC past the line, and not below it, from stored reports while the host isn't receiving", async () => {
    await setHost(false);
    await seedReport({ provider: 190, providerFailing: 9 });
    expect((await readDomainStanding(fixture.organizationId, fixture.domainId, NOW))?.findings.map((finding) => finding.kind)).not.toContain("dmarc_failing");

    await seedReport({ providerFailing: 11 });
    const standing = await readDomainStanding(fixture.organizationId, fixture.domainId, NOW);
    expect(standing?.standing).toBe("watch");
    expect(standing?.findings.find((finding) => finding.kind === "dmarc_failing")?.title).toBe("10% of example.com's mail failed DMARC");
  });

  it("says someone else may be sending as the domain once enough unauthenticated mail is reported, whatever the host's state", async () => {
    await seedReport({ provider: 500, spoofed: SPOOFED_MIN_MESSAGES - 1 });
    expect(await runObservations(fixture.organizationId, NOW, [domainSpoofed])).toEqual([]);

    await seedReport({ spoofed: 1 });
    const [result] = await runObservations(fixture.organizationId, NOW, [domainSpoofed]);
    expect(result?.wording.title).toBe("Someone else may be sending as example.com");
    expect(result?.wording.body).toContain(`${SPOOFED_MIN_MESSAGES} messages from 1 source`);
  });

  it("stays quiet on reports older than the window, and for an organization that turned reports off", async () => {
    await setHost(true);
    await seedReport({ spoofed: 50, daysAgo: 8 });
    expect(await runObservations(fixture.organizationId, NOW, [domainSpoofed])).toEqual([]);

    await seedReport({ spoofed: 50 });
    await db.update(organizations).set({ dmarcReportsEnabled: false }).where(eq(organizations.id, fixture.organizationId));
    expect(await runObservations(fixture.organizationId, NOW, [domainSpoofed])).toEqual([]);
  });
});

describe("the domain panel", () => {
  it("shows stored reports while the host isn't receiving, and says new ones aren't arriving", async () => {
    expect(await readDmarcPanel(fixture.organizationId, { id: fixture.domainId, name: "example.com" }, NOW)).toBeNull();

    await seedReport({ provider: 40, spoofed: 3 });
    const stored = await readDmarcPanel(fixture.organizationId, { id: fixture.domainId, name: "example.com" }, NOW);
    expect(stored).toMatchObject({ receiving: false, summary: { reports: 1, byOrigin: { provider: { messages: 40 }, unauthenticated: { messages: 3 } } } });

    await setHost(true);
    expect((await readDmarcPanel(fixture.organizationId, { id: fixture.domainId, name: "example.com" }, NOW))?.receiving).toBe(true);
  });

  it("shows an empty panel only while the host is receiving, and nothing for an organization that turned reports off", async () => {
    await setHost(true);
    expect((await readDmarcPanel(fixture.organizationId, { id: fixture.domainId, name: "example.com" }, NOW))?.summary.reports).toBe(0);

    await seedReport({ provider: 5 });
    await db.update(organizations).set({ dmarcReportsEnabled: false }).where(eq(organizations.id, fixture.organizationId));
    expect(await readDmarcPanel(fixture.organizationId, { id: fixture.domainId, name: "example.com" }, NOW)).toBeNull();
  });
});

describe("the panel's verdict", () => {
  const verdict = (messages: number, failing: number, unauthenticated = 0) =>
    dmarcVerdict("example.com", { provider: { messages, dmarc: messages - failing }, unauthenticated }, 7);

  it("reads healthy while the provider's mail passes and too little else fails", () => {
    expect(verdict(100, 0)).toEqual({ standing: "healthy", headline: "Your mail passes DMARC. No one else is sending as example.com." });
    expect(verdict(100, 0, SPOOFED_MIN_MESSAGES - 1)).toEqual({
      standing: "healthy",
      headline: `Your mail passes DMARC. Other sources sent ${SPOOFED_MIN_MESSAGES - 1} messages that failed it, too few to flag.`,
    });
    expect(verdict(0, 0).headline).toBe("No reports of your own mail in the last 7 days. No one else is sending as example.com.");
  });

  it("watches once someone else sends at the observation's line, or any of the provider's mail fails", () => {
    expect(verdict(100, 0, SPOOFED_MIN_MESSAGES)).toEqual({ standing: "watch", headline: `Someone else sent ${SPOOFED_MIN_MESSAGES} messages as example.com in the last 7 days.` });
    expect(verdict(100, 1)).toEqual({ standing: "watch", headline: "1 of your 100 messages failed DMARC in the last 7 days." });
  });

  it("is at risk at the finding's line and not one message under it, nor below its volume", () => {
    const line = Math.ceil(DMARC_FAILING_MIN_MESSAGES * DMARC_FAILING_WATCH_SHARE);
    expect(verdict(DMARC_FAILING_MIN_MESSAGES, line)).toEqual({ standing: "at_risk", headline: "5.0% of your mail failed DMARC in the last 7 days. Receivers may reject it once your policy tightens." });
    expect(verdict(200, 11).headline).toBe("5.5% of your mail failed DMARC in the last 7 days. Receivers may reject it once your policy tightens.");
    expect(verdict(DMARC_FAILING_MIN_MESSAGES, line - 1).standing).toBe("watch");
    expect(verdict(DMARC_FAILING_MIN_MESSAGES - 1, DMARC_FAILING_MIN_MESSAGES - 1).standing).toBe("watch");
    expect(verdict(DMARC_FAILING_MIN_MESSAGES, line, SPOOFED_MIN_MESSAGES).standing).toBe("at_risk");
  });
});

describe("the p=quarantine nudge", () => {
  const domain = () => ({ id: fixture.domainId, name: "example.com" });
  const rua = `mailto:tok@${HOST}`;

  async function healthyDays(count: number, from = 1): Promise<void> {
    for (let day = from; day < from + count; day += 1) await seedReport({ provider: 50, daysAgo: day });
  }

  it(`offers the record with only p changed after ${READY_DAYS} healthy days in a row, and not after one fewer`, async () => {
    zone.set("_dmarc.example.com", [`v=DMARC1; p=none; rua=${rua}; adkim=s`]);
    await healthyDays(READY_DAYS - 1);
    expect(await readHealthyStreak(fixture.organizationId, domain(), NOW)).toBe(READY_DAYS - 1);
    expect(await readQuarantineRecommendation(fixture.organizationId, domain(), NOW)).toBeNull();

    await healthyDays(1, READY_DAYS);
    expect((await readDmarcPanel(fixture.organizationId, domain(), NOW))?.recommendation).toEqual({
      name: "_dmarc.example.com",
      value: `v=DMARC1; p=quarantine; rua=${rua}; adkim=s;`,
      days: READY_DAYS,
    });
  });

  it("says nothing once the policy is already past none", async () => {
    zone.set("_dmarc.example.com", [`v=DMARC1; p=quarantine; rua=${rua}`]);
    await healthyDays(READY_DAYS);
    expect(await readHealthyStreak(fixture.organizationId, domain(), NOW)).toBe(READY_DAYS);
    expect(await readQuarantineRecommendation(fixture.organizationId, domain(), NOW)).toBeNull();
  });

  it("restarts the streak on a day that wasn't healthy, and drops it once reports stop arriving", async () => {
    zone.set("_dmarc.example.com", ["v=DMARC1; p=none"]);
    await healthyDays(READY_DAYS);
    await seedReport({ providerFailing: 1, daysAgo: 10 });
    expect(await readHealthyStreak(fixture.organizationId, domain(), NOW)).toBe(9);
    expect(await readQuarantineRecommendation(fixture.organizationId, domain(), NOW)).toBeNull();

    expect(await readHealthyStreak(fixture.organizationId, domain(), new Date(NOW.getTime() + 4 * DAY))).toBe(0);
  });
});

describe("the p=quarantine email", () => {
  const SUBJECT = "Next step for example.com: p=quarantine";
  let owner: string;

  async function addMember(role: "owner" | "member"): Promise<string> {
    const userId = crypto.randomUUID();
    const email = `${role}-${userId.slice(0, 8)}@owners.example`;
    await db.insert(users).values({ id: userId, organizationId: fixture.organizationId, name: role, email });
    await db.insert(memberships).values({ id: `mem_${userId.slice(0, 12)}`, userId, organizationId: fixture.organizationId, role });
    return email;
  }

  async function sentTo(email: string): Promise<string[]> {
    return (await systemMailMessages()).filter((message) => message.recipients.includes(email)).map((message) => message.subject ?? "");
  }

  function publish(record: string): void {
    zone.set("_dmarc.example.com", [record]);
    resetDnsCheckCache();
  }

  async function qualify(days = READY_DAYS): Promise<void> {
    await token();
    for (let day = 1; day <= days; day += 1) await seedReport({ provider: 50, daysAgo: day });
  }

  beforeEach(async () => {
    await seedSystemOrganization();
    owner = await addMember("owner");
    await addMember("member");
  });

  it("emails owners once with the record and logs it, and the next pass stays quiet", async () => {
    publish(`v=DMARC1; p=none; rua=mailto:tok@${HOST}`);
    await qualify();

    expect(await checkDmarcPolicyReady(fixture.organizationId, NOW)).toBe(1);
    expect(await sentTo(owner)).toEqual([SUBJECT]);
    expect((await systemMailMessages()).length).toBe(1);
    const [logged] = await db.select().from(activity).where(eq(activity.action, "domain.dmarc_policy.recommended"));
    expect(logged).toMatchObject({ appliesTo: fixture.domainId, metadata: { record: `v=DMARC1; p=quarantine; rua=mailto:tok@${HOST};`, days: READY_DAYS } });

    expect(await checkDmarcPolicyReady(fixture.organizationId, new Date(NOW.getTime() + 60_000))).toBe(0);
    expect(await sentTo(owner)).toEqual([SUBJECT]);
  });

  it("sends again only after the policy moved past none and came back", async () => {
    publish("v=DMARC1; p=none");
    await qualify();
    await checkDmarcPolicyReady(fixture.organizationId, NOW);

    publish("v=DMARC1; p=quarantine");
    expect(await checkDmarcPolicyReady(fixture.organizationId, new Date(NOW.getTime() + 60_000))).toBe(0);
    const [row] = await db.select().from(dmarcDomainTokens).where(eq(dmarcDomainTokens.domainId, fixture.domainId));
    expect(row?.policyReadyNotifiedAt).toBeNull();

    publish("v=DMARC1; p=none");
    expect(await checkDmarcPolicyReady(fixture.organizationId, new Date(NOW.getTime() + 120_000))).toBe(1);
    expect(await sentTo(owner)).toEqual([SUBJECT, SUBJECT]);
  });

  it(`says nothing a day short of ${READY_DAYS}, or for an organization that turned reports off`, async () => {
    publish("v=DMARC1; p=none");
    await qualify(READY_DAYS - 1);
    expect(await checkDmarcPolicyReady(fixture.organizationId, NOW)).toBe(0);

    await seedReport({ provider: 50, daysAgo: READY_DAYS });
    await db.update(organizations).set({ dmarcReportsEnabled: false }).where(eq(organizations.id, fixture.organizationId));
    expect(await checkDmarcPolicyReady(fixture.organizationId, NOW)).toBe(0);
    expect(await systemMailMessages()).toEqual([]);

    await db.update(organizations).set({ dmarcReportsEnabled: true }).where(eq(organizations.id, fixture.organizationId));
    expect(await checkDmarcPolicyReady(fixture.organizationId, NOW)).toBe(1);
  });
});

describe("retention and the API", () => {
  it("deletes reports past the organization's body retention, rows and all", async () => {
    await db.update(organizations).set({ bodyRetentionDays: 7 }).where(eq(organizations.id, fixture.organizationId));
    await seedReport({ provider: 5, reportId: "old" });
    await seedReport({ provider: 5, reportId: "new" });
    await db.update(dmarcReports).set({ receivedAt: new Date(NOW.getTime() - 8 * DAY) }).where(eq(dmarcReports.reportId, "old"));
    await db.update(dmarcReports).set({ receivedAt: new Date(NOW.getTime() - 6 * DAY) }).where(eq(dmarcReports.reportId, "new"));

    expect(await purgeExpiredReports(NOW, 100)).toBe(1);
    expect((await db.select().from(dmarcReports)).map((row) => row.reportId)).toEqual(["new"]);
    expect(await db.select().from(dmarcReportRecords)).toHaveLength(1);
  });

  it("lists a domain's reports newest first, with rows on request, and refuses a key scoped elsewhere", async () => {
    await seedReport({ provider: 5, spoofed: 2, daysAgo: 3, reportId: "older" });
    await seedReport({ provider: 9, daysAgo: 1, reportId: "newer" });

    const path = `/v1/domains/${fixture.domainId}/dmarc_reports`;
    const plain = await listReports(apiRequest(fixture.secret, `${path}?limit=1`), routeContext(fixture.domainId));
    const page = (await plain.json()) as { data: { report_id: string; records?: unknown }[]; next_cursor: string | null };
    expect(page.data.map((report) => report.report_id)).toEqual(["newer"]);
    expect(page.data[0]!.records).toBeUndefined();

    const next = await listReports(apiRequest(fixture.secret, `${path}?include=records&cursor=${page.next_cursor}`), routeContext(fixture.domainId));
    const rest = (await next.json()) as { data: { report_id: string; records: { origin: string; count: number }[] }[]; next_cursor: string | null };
    expect(rest.data.map((report) => report.report_id)).toEqual(["older"]);
    expect(rest.data[0]!.records.map((record) => [record.origin, record.count])).toEqual([
      ["provider", 5],
      ["unauthenticated", 2],
    ]);
    expect(rest.next_cursor).toBeNull();

    const other = await addDomainKey(fixture);
    const refused = await listReports(apiRequest(other.secret, path), routeContext(fixture.domainId));
    expect(refused.status).toBe(403);
  });
});

describe("the dmarc_reports feature", () => {
  const ADMIN = adminActor("usr_admin", "Admin");
  const path = () => `/v1/domains/${fixture.domainId}/dmarc_reports`;
  const turnOff = () => setSetting("dmarc_reports", false, ADMIN);

  async function dmarcValue(): Promise<string | undefined> {
    const response = await readDomainRoute(apiRequest(fixture.secret, `/v1/domains/${fixture.domainId}`), routeContext(fixture.domainId));
    const body = (await response.json()) as { dns_records: { name: string; value: string }[] };
    return body.dns_records.find((record) => record.name === "_dmarc.example.com")?.value;
  }

  it("answers feature_disabled on the API while it's off, and works while it's on", async () => {
    expect((await listReports(apiRequest(fixture.secret, path()), routeContext(fixture.domainId))).status).toBe(200);

    await turnOff();
    const response = await listReports(apiRequest(fixture.secret, path()), routeContext(fixture.domainId));
    const body = (await response.json()) as { error: { code: string; detail?: { feature?: string } } };
    expect([response.status, body.error.code, body.error.detail?.feature]).toEqual([403, "feature_disabled", "dmarc_reports"]);

    await setSetting("dmarc_reports", true, ADMIN);
    expect((await listReports(apiRequest(fixture.secret, path()), routeContext(fixture.domainId))).status).toBe(200);
  });

  it("takes the rua out of the recommended record, and puts it back", async () => {
    await setHost(true);
    expect(await dmarcValue()).toMatch(/rua=mailto:[0-9a-f]{24}@reports\.example\.net;$/);

    await turnOff();
    expect(await dmarcValue()).toBe("v=DMARC1; p=none;");

    await setSetting("dmarc_reports", true, ADMIN);
    expect(await dmarcValue()).toMatch(/rua=mailto:/);
  });

  it("drops report mail on the host, deleting the provider's copy", async () => {
    await setHost();
    const own = await token();
    await turnOff();
    const mail = stored(message({}, `${own}@${HOST}`), [`${own}@${HOST}`]);

    expect(await receiveProviderMail(fixture.providerId, mail)).toEqual({ accepted: 0, duplicates: 0 });
    expect(mail.discarded()).toBe(true);
    expect(await db.select().from(dmarcReports)).toHaveLength(0);

    await setSetting("dmarc_reports", true, ADMIN);
    expect(await receiveProviderMail(fixture.providerId, stored(message({}, `${own}@${HOST}`), [`${own}@${HOST}`]))).toEqual({ accepted: 1, duplicates: 0 });
  });

  it("raises no finding and no observation, and shows no panel", async () => {
    await setHost(true);
    await seedReport({ provider: 190, providerFailing: 20, spoofed: SPOOFED_MIN_MESSAGES });
    const kinds = async () => (await readDomainStanding(fixture.organizationId, fixture.domainId, NOW))?.findings.map((finding) => finding.kind);
    expect(await kinds()).toContain("dmarc_failing");
    expect(await runObservations(fixture.organizationId, NOW, [domainSpoofed])).toHaveLength(1);
    expect(await readDmarcPanel(fixture.organizationId, { id: fixture.domainId, name: "example.com" }, NOW)).not.toBeNull();

    await turnOff();
    expect(await kinds()).not.toContain("dmarc_failing");
    expect(await runObservations(fixture.organizationId, NOW, [domainSpoofed])).toEqual([]);
    expect(await readDmarcPanel(fixture.organizationId, { id: fixture.domainId, name: "example.com" }, NOW)).toBeNull();
  });

  it("sends no p=quarantine email", async () => {
    await seedSystemOrganization();
    const userId = crypto.randomUUID();
    await db.insert(users).values({ id: userId, organizationId: fixture.organizationId, name: "owner", email: "owner@owners.example" });
    await db.insert(memberships).values({ id: `mem_${userId.slice(0, 12)}`, userId, organizationId: fixture.organizationId, role: "owner" });
    zone.set("_dmarc.example.com", ["v=DMARC1; p=none"]);
    await token();
    for (let day = 1; day <= READY_DAYS; day += 1) await seedReport({ provider: 50, daysAgo: day });

    await turnOff();
    expect(await checkDmarcPolicyReady(fixture.organizationId, NOW)).toBe(0);
    expect(await systemMailMessages()).toEqual([]);

    await setSetting("dmarc_reports", true, ADMIN);
    expect(await checkDmarcPolicyReady(fixture.organizationId, NOW)).toBe(1);
  });
});
