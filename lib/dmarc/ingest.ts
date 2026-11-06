import { simpleParser } from "mailparser";
import { db } from "@/lib/db";
import { dmarcReportRecords, dmarcReports, type domains } from "@/lib/db/schema";
import { organizationalDomain } from "@/lib/domains/dmarc";
import { newId } from "@/lib/ids";
import { inboundHost } from "@/lib/inbound/records";
import { logger } from "@/lib/logger";
import { classifyRecord, providerIdentity } from "./classify";
import { MAX_ATTACHMENT_BYTES, parseReportXml, ReportParseError, unpackAttachment, type AggregateReport } from "./parse";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("dmarc-reports:ingest");

type DomainRow = typeof domains.$inferSelect;

/** Largest report message read. */
export const MAX_MESSAGE_BYTES = 2 * MAX_ATTACHMENT_BYTES;

const INSERT_CHUNK = 1000;

export type ReportOutcome =
  | { outcome: "stored"; reportId: string; records: number }
  | { outcome: "duplicate" }
  | { outcome: "rejected"; reason: string };

/** The first attachment that reads as an aggregate report. */
async function reportIn(raw: Buffer): Promise<AggregateReport> {
  if (raw.length > MAX_MESSAGE_BYTES) throw new ReportParseError("the message is larger than a report may be");
  const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
  let last: ReportParseError | null = null;
  for (const attachment of parsed.attachments) {
    try {
      return parseReportXml(unpackAttachment(attachment.content));
    } catch (error) {
      if (!(error instanceof ReportParseError)) throw error;
      last = error;
    }
  }
  throw last ?? new ReportParseError("the message has no report attached");
}

/**
 * Reads one report message for `domain` and stores its rows for that domain. A report about
 * another domain, or with no rows for this one, is rejected; a second copy of the same
 * reporter's report id is a duplicate. Never throws on bad input.
 */
export async function ingestDmarcReport(domain: DomainRow, raw: Buffer): Promise<ReportOutcome> {
  let report: AggregateReport;
  try {
    report = await reportIn(raw);
  } catch (error) {
    if (!(error instanceof ReportParseError)) throw error;
    log.warn(`rejected a report for ${domain.name}: ${safeErrorMessage(error)}`);
    return { outcome: "rejected", reason: error.message };
  }

  const name = domain.name.toLowerCase();
  if (report.policy.domain !== name && report.policy.domain !== organizationalDomain(name)) {
    log.warn(`rejected ${report.reporter}'s report ${report.reportId} for ${domain.name}: it's about ${report.policy.domain}`);
    return { outcome: "rejected", reason: `the report is about ${report.policy.domain}` };
  }
  const rows = report.records.filter((record) => record.headerFrom === name);
  if (rows.length === 0) {
    return { outcome: "rejected", reason: `the report has no rows for ${domain.name}` };
  }

  const identity = providerIdentity(name, domain.dnsRecords, domain.inboundEnabled ? inboundHost(name, domain.inboundSubdomain) : null);
  const id = newId("dmarcReport");
  const stored = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(dmarcReports)
      .values({
        id,
        organizationId: domain.organizationId,
        domainId: domain.id,
        reporter: report.reporter,
        reporterEmail: report.reporterEmail,
        reportId: report.reportId,
        beginsAt: report.begin,
        endsAt: report.end,
        policy: report.policy,
        messageCount: rows.reduce((sum, row) => sum + row.count, 0),
      })
      .onConflictDoNothing({ target: [dmarcReports.domainId, dmarcReports.reporter, dmarcReports.reportId] })
      .returning({ id: dmarcReports.id });
    if (!inserted) return false;

    const values = rows.map((row) => ({
      id: newId("dmarcReportRecord"),
      organizationId: domain.organizationId,
      reportId: id,
      domainId: domain.id,
      endsAt: report.end,
      sourceIp: row.sourceIp,
      count: row.count,
      origin: classifyRecord(name, row, identity),
      disposition: row.disposition,
      dkim: row.dkim,
      spf: row.spf,
      headerFrom: row.headerFrom,
      envelopeFrom: row.envelopeFrom,
      dkimResults: row.dkimResults,
      spfResults: row.spfResults,
    }));
    for (let at = 0; at < values.length; at += INSERT_CHUNK) {
      await tx.insert(dmarcReportRecords).values(values.slice(at, at + INSERT_CHUNK));
    }
    return true;
  });

  if (!stored) return { outcome: "duplicate" };
  return { outcome: "stored", reportId: id, records: rows.length };
}
