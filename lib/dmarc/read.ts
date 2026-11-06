/** What the stored reports say: the domain panel's summary, the standing signal and the observation's read. */
import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dmarcReportRecords, dmarcReports, type DmarcOrigin } from "@/lib/db/schema";
import { parseDmarc, readDmarc, withPolicy, type DmarcPolicy } from "@/lib/domains/dmarc";
import { formatNumber } from "@/lib/format/number";
import { DMARC_FAILING_MIN_MESSAGES, DMARC_FAILING_WATCH_SHARE, DMARC_SIGNAL_DAYS, type Standing } from "@/lib/reputation/standing";
import { activeReportHost } from "./host";
import { dmarcOnFor } from "./switch";

export type { DmarcOrigin };

const DAY_MS = 24 * 60 * 60 * 1000;

/** The window the domain panel reads. */
export const PANEL_WINDOW_DAYS = 30;

/** Sources the panel lists. */
export const SOURCE_LIMIT = 50;

export interface PassCounts {
  messages: number;
  /** Messages whose DKIM, SPF or either aligned and passed, as the receiver evaluated them. */
  dkim: number;
  spf: number;
  dmarc: number;
}

export interface DmarcSource extends PassCounts {
  ip: string;
  origin: DmarcOrigin;
}

export interface DmarcSummary {
  days: number;
  reports: number;
  reporters: number;
  lastReportAt: Date | null;
  byOrigin: Record<DmarcOrigin, PassCounts>;
  /** Most messages first. */
  sources: DmarcSource[];
}

const EMPTY_COUNTS: PassCounts = { messages: 0, dkim: 0, spf: 0, dmarc: 0 };

const passColumns = {
  messages: sql<number>`coalesce(sum(${dmarcReportRecords.count}), 0)::int`,
  dkim: sql<number>`coalesce(sum(${dmarcReportRecords.count}) filter (where ${dmarcReportRecords.dkim} = 'pass'), 0)::int`,
  spf: sql<number>`coalesce(sum(${dmarcReportRecords.count}) filter (where ${dmarcReportRecords.spf} = 'pass'), 0)::int`,
  dmarc: sql<number>`coalesce(sum(${dmarcReportRecords.count}) filter (where ${dmarcReportRecords.dkim} = 'pass' or ${dmarcReportRecords.spf} = 'pass'), 0)::int`,
};

/** Reports whose period ended in the `days` up to `now`, for one domain. */
export async function readDmarcSummary(organizationId: string, domainId: string, now: Date, days = PANEL_WINDOW_DAYS): Promise<DmarcSummary> {
  const since = new Date(now.getTime() - days * DAY_MS);
  const window = and(
    eq(dmarcReportRecords.organizationId, organizationId),
    eq(dmarcReportRecords.domainId, domainId),
    gt(dmarcReportRecords.endsAt, since),
    lte(dmarcReportRecords.endsAt, now),
  );

  const [reports, origins, sources] = await Promise.all([
    db
      .select({
        reports: sql<number>`count(*)::int`,
        reporters: sql<number>`count(distinct ${dmarcReports.reporter})::int`,
        lastReportAt: sql<string | null>`max(${dmarcReports.endsAt})`,
      })
      .from(dmarcReports)
      .where(and(eq(dmarcReports.organizationId, organizationId), eq(dmarcReports.domainId, domainId), gt(dmarcReports.endsAt, since), lte(dmarcReports.endsAt, now))),
    db.select({ origin: dmarcReportRecords.origin, ...passColumns }).from(dmarcReportRecords).where(window).groupBy(dmarcReportRecords.origin),
    db
      .select({ ip: dmarcReportRecords.sourceIp, origin: dmarcReportRecords.origin, ...passColumns })
      .from(dmarcReportRecords)
      .where(window)
      .groupBy(dmarcReportRecords.sourceIp, dmarcReportRecords.origin)
      .orderBy(desc(passColumns.messages), dmarcReportRecords.sourceIp)
      .limit(SOURCE_LIMIT),
  ]);

  const byOrigin: Record<DmarcOrigin, PassCounts> = { provider: EMPTY_COUNTS, other: EMPTY_COUNTS, forwarded: EMPTY_COUNTS, unauthenticated: EMPTY_COUNTS };
  for (const row of origins) byOrigin[row.origin] = { messages: row.messages, dkim: row.dkim, spf: row.spf, dmarc: row.dmarc };
  const head = reports[0];
  return {
    days,
    reports: head?.reports ?? 0,
    reporters: head?.reporters ?? 0,
    lastReportAt: head?.lastReportAt ? new Date(head.lastReportAt) : null,
    byOrigin,
    sources,
  };
}

/** Unauthenticated messages in the signal window that make someone else sending as the domain worth a look. */
export const SPOOFED_MIN_MESSAGES = 10;

/** Days of reports in a row, every one healthy, before the domain is ready for `p=quarantine`. */
export const READY_DAYS = 30;

/** The latest day of reports may lag this many days behind today and still count toward a streak. */
const STREAK_LAG_DAYS = 2;

export type DmarcVerdictStanding = Exclude<Standing, "paused">;

export interface DmarcVerdict {
  standing: DmarcVerdictStanding;
  /** One sentence naming the biggest problem, or that there isn't one. */
  headline: string;
}

export interface VerdictCounts {
  /** The provider's own mail, and how much of it passed DMARC. */
  provider: { messages: number; dmarc: number };
  /** Mail that failed DMARC and carried nothing of the domain's. */
  unauthenticated: number;
}

/** `part` of `whole` as a percent, one decimal unless it rounds to 0 or 100. */
export function passShare(part: number, whole: number): string {
  if (whole === 0) return "—";
  const value = (part / whole) * 100;
  return `${value >= 99.95 || value === 0 ? Math.round(value) : value.toFixed(1)}%`;
}

function messages(count: number): string {
  return `${formatNumber(count)} ${count === 1 ? "message" : "messages"}`;
}

/**
 * The panel's verdict, by the lines the `dmarc_failing` finding and the `domain_spoofed`
 * observation use: at risk when the provider's own mail fails DMARC at the finding's line, watch
 * when any of it fails or the observation would fire, healthy otherwise.
 */
export function dmarcVerdict(domain: string, counts: VerdictCounts, days: number): DmarcVerdict {
  const failing = counts.provider.messages - counts.provider.dmarc;
  const share = counts.provider.messages > 0 ? failing / counts.provider.messages : 0;

  if (counts.provider.messages >= DMARC_FAILING_MIN_MESSAGES && share >= DMARC_FAILING_WATCH_SHARE) {
    return { standing: "at_risk", headline: `${passShare(failing, counts.provider.messages)} of your mail failed DMARC in the last ${days} days. Receivers may reject it once your policy tightens.` };
  }
  if (counts.unauthenticated >= SPOOFED_MIN_MESSAGES) {
    return { standing: "watch", headline: `Someone else sent ${messages(counts.unauthenticated)} as ${domain} in the last ${days} days.` };
  }
  if (failing > 0) {
    return { standing: "watch", headline: `${formatNumber(failing)} of your ${messages(counts.provider.messages)} failed DMARC in the last ${days} days.` };
  }
  const own = counts.provider.messages > 0 ? "Your mail passes DMARC." : `No reports of your own mail in the last ${days} days.`;
  if (counts.unauthenticated > 0) {
    return { standing: "healthy", headline: `${own} Other sources sent ${messages(counts.unauthenticated)} that failed it, too few to flag.` };
  }
  return { standing: "healthy", headline: `${own} No one else is sending as ${domain}.` };
}

function verdictCounts(origins: Partial<Record<DmarcOrigin, { messages: number; dmarc: number }>> | undefined): VerdictCounts {
  return {
    provider: { messages: origins?.provider?.messages ?? 0, dmarc: origins?.provider?.dmarc ?? 0 },
    unauthenticated: origins?.unauthenticated?.messages ?? 0,
  };
}

/**
 * Days in a row, by the UTC day each report's period ends, whose reports read healthy, counted
 * back from the latest day with reports. A day without reports ends the streak, and so does a
 * latest day more than `STREAK_LAG_DAYS` old.
 */
export async function readHealthyStreak(organizationId: string, domain: { id: string; name: string }, now: Date): Promise<number> {
  const since = new Date(now.getTime() - (READY_DAYS + STREAK_LAG_DAYS + 1) * DAY_MS);
  const day = sql<string>`to_char(${dmarcReportRecords.endsAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const rows = await db
    .select({ day, origin: dmarcReportRecords.origin, messages: passColumns.messages, dmarc: passColumns.dmarc })
    .from(dmarcReportRecords)
    .where(and(eq(dmarcReportRecords.organizationId, organizationId), eq(dmarcReportRecords.domainId, domain.id), gt(dmarcReportRecords.endsAt, since), lte(dmarcReportRecords.endsAt, now)))
    .groupBy(day, dmarcReportRecords.origin);

  const byDay = new Map<string, Partial<Record<DmarcOrigin, { messages: number; dmarc: number }>>>();
  for (const row of rows) byDay.set(row.day, { ...byDay.get(row.day), [row.origin]: { messages: row.messages, dmarc: row.dmarc } });
  const latest = [...byDay.keys()].sort().at(-1);
  if (!latest || now.getTime() - Date.parse(`${latest}T00:00:00Z`) > (STREAK_LAG_DAYS + 1) * DAY_MS) return 0;

  let streak = 0;
  for (let cursor = Date.parse(`${latest}T00:00:00Z`); ; cursor -= DAY_MS) {
    const origins = byDay.get(new Date(cursor).toISOString().slice(0, 10));
    if (!origins || dmarcVerdict(domain.name, verdictCounts(origins), 1).standing !== "healthy") return streak;
    streak += 1;
  }
}

export interface QuarantineRecommendation {
  name: string;
  /** The published record with `p=quarantine`, every other tag kept. */
  value: string;
  /** Healthy days in a row behind it. */
  days: number;
}

/**
 * The record that moves the domain to `p=quarantine`: offered once its reports have read healthy
 * for `READY_DAYS` days in a row and its own record, read live, is `p=none`. Null otherwise.
 */
export async function readQuarantineRecommendation(organizationId: string, domain: { id: string; name: string }, now: Date): Promise<QuarantineRecommendation | null> {
  const days = await readHealthyStreak(organizationId, domain, now);
  if (days < READY_DAYS) return null;
  const own = await readOwnPolicy(domain.name);
  if (!own || own.policy !== "none") return null;
  return { name: own.name, value: withPolicy(own.record, "quarantine"), days };
}

/** The domain's own single, readable DMARC record, read live. Null when there isn't one or DNS didn't answer. */
export async function readOwnPolicy(domain: string): Promise<{ name: string; record: string; policy: DmarcPolicy } | null> {
  const lookup = await readDmarc(domain);
  if (!lookup || lookup.source !== "domain" || lookup.records.length !== 1) return null;
  const record = lookup.records[0]!;
  const parsed = parseDmarc(record);
  return parsed.ok ? { name: lookup.host, record, policy: parsed.tags.policy } : null;
}

export interface DmarcPanel {
  summary: DmarcSummary;
  /** Over the signal window, by the same lines as the finding and the observation. */
  verdict: DmarcVerdict;
  verdictDays: number;
  /** False while the report host isn't set up or its records don't check out, so new reports aren't arriving. */
  receiving: boolean;
  recommendation: QuarantineRecommendation | null;
}

/**
 * The domain panel's read. Stored reports show whatever the host's state; with none, the panel
 * shows only while the host is receiving. Null when the organization turned reports off.
 */
export async function readDmarcPanel(organizationId: string, domain: { id: string; name: string }, now: Date): Promise<DmarcPanel | null> {
  const [on, host] = await Promise.all([dmarcOnFor(organizationId), activeReportHost()]);
  if (!on) return null;
  const [summary, counts, recommendation] = await Promise.all([
    readDmarcSummary(organizationId, domain.id, now),
    readOriginCounts(organizationId, now, [domain.id]),
    readQuarantineRecommendation(organizationId, domain, now),
  ]);
  if (summary.reports === 0 && !host) return null;
  return {
    summary,
    verdict: dmarcVerdict(domain.name, verdictCounts(counts.get(domain.id)), DMARC_SIGNAL_DAYS),
    verdictDays: DMARC_SIGNAL_DAYS,
    receiving: host !== null,
    recommendation,
  };
}

/** Per domain, messages by origin and how many passed DMARC, over the signal window. */
export async function readOriginCounts(
  organizationId: string,
  now: Date,
  domainIds?: string[],
): Promise<Map<string, Partial<Record<DmarcOrigin, { messages: number; dmarc: number; sources: number }>>>> {
  const since = new Date(now.getTime() - DMARC_SIGNAL_DAYS * DAY_MS);
  const rows = await db
    .select({
      domainId: dmarcReportRecords.domainId,
      origin: dmarcReportRecords.origin,
      messages: passColumns.messages,
      dmarc: passColumns.dmarc,
      sources: sql<number>`count(distinct ${dmarcReportRecords.sourceIp})::int`,
    })
    .from(dmarcReportRecords)
    .where(
      and(
        eq(dmarcReportRecords.organizationId, organizationId),
        domainIds ? inArray(dmarcReportRecords.domainId, domainIds) : undefined,
        gt(dmarcReportRecords.endsAt, since),
        lte(dmarcReportRecords.endsAt, now),
      ),
    )
    .groupBy(dmarcReportRecords.domainId, dmarcReportRecords.origin);

  const counts = new Map<string, Partial<Record<DmarcOrigin, { messages: number; dmarc: number; sources: number }>>>();
  for (const row of rows) {
    counts.set(row.domainId, { ...counts.get(row.domainId), [row.origin]: { messages: row.messages, dmarc: row.dmarc, sources: row.sources } });
  }
  return counts;
}

/** The provider's own mail in stored reports over the signal window, and how much of it failed DMARC. Only domains with any. */
export async function readProviderAlignment(organizationId: string, now: Date, domainIds?: string[]): Promise<Map<string, { messages: number; failing: number }>> {
  if (!(await dmarcOnFor(organizationId))) return new Map();
  const counts = await readOriginCounts(organizationId, now, domainIds);
  return new Map(
    [...counts].flatMap(([domainId, origins]) => {
      const provider = origins.provider;
      return provider ? [[domainId, { messages: provider.messages, failing: provider.messages - provider.dmarc }] as const] : [];
    }),
  );
}
