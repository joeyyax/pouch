/** `GET /v1/domains/:id/dmarc_reports`: a domain's stored aggregate reports, newest first. */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { dmarcReportRecords, dmarcReports, type DmarcOrigin, type DmarcPublishedPolicy } from "@/lib/db/schema";
import { keysetBefore } from "@/lib/db/keyset";
import { domainFor, type DomainCaller } from "@/lib/domains";

export interface SerializedDmarcRecord {
  source_ip: string;
  count: number;
  origin: DmarcOrigin;
  disposition: string;
  dkim: string;
  spf: string;
  header_from: string;
  envelope_from: string | null;
  dkim_results: { domain: string; selector: string | null; result: string }[];
  spf_results: { domain: string; scope: string | null; result: string }[];
}

export interface SerializedDmarcReport {
  id: string;
  domain_id: string;
  reporter: string;
  reporter_email: string | null;
  report_id: string;
  begins_at: string;
  ends_at: string;
  policy: DmarcPublishedPolicy;
  message_count: number;
  received_at: string;
  records?: SerializedDmarcRecord[];
}

export interface DmarcReportPage {
  data: SerializedDmarcReport[];
  next_cursor: string | null;
}

export async function listDmarcReports(
  caller: DomainCaller,
  domainId: string,
  limit: number,
  cursor: string | undefined,
  options: { records: boolean },
): Promise<DmarcReportPage> {
  const domain = await domainFor(caller, domainId);
  const rows = await db
    .select()
    .from(dmarcReports)
    .where(
      and(
        eq(dmarcReports.organizationId, caller.organizationId),
        eq(dmarcReports.domainId, domain.id),
        cursor ? keysetBefore({ table: dmarcReports, sort: dmarcReports.endsAt, id: dmarcReports.id }, cursor) : undefined,
      ),
    )
    .orderBy(desc(dmarcReports.endsAt), desc(dmarcReports.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);

  const records = options.records && page.length > 0
    ? await db
        .select()
        .from(dmarcReportRecords)
        .where(and(eq(dmarcReportRecords.organizationId, caller.organizationId), inArray(dmarcReportRecords.reportId, page.map((row) => row.id))))
        .orderBy(desc(dmarcReportRecords.count), asc(dmarcReportRecords.sourceIp))
    : [];

  return {
    data: page.map((row) => ({
      id: row.id,
      domain_id: row.domainId,
      reporter: row.reporter,
      reporter_email: row.reporterEmail,
      report_id: row.reportId,
      begins_at: row.beginsAt.toISOString(),
      ends_at: row.endsAt.toISOString(),
      policy: row.policy,
      message_count: row.messageCount,
      received_at: row.receivedAt.toISOString(),
      ...(options.records
        ? {
            records: records
              .filter((record) => record.reportId === row.id)
              .map((record) => ({
                source_ip: record.sourceIp,
                count: record.count,
                origin: record.origin,
                disposition: record.disposition,
                dkim: record.dkim,
                spf: record.spf,
                header_from: record.headerFrom,
                envelope_from: record.envelopeFrom,
                dkim_results: record.dkimResults,
                spf_results: record.spfResults,
              })),
          }
        : {}),
    })),
    next_cursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}
