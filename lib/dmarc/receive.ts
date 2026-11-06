/** Mail to the report host: each recipient token resolves to its domain, and nothing is delivered anywhere else. */
import { eq, inArray } from "drizzle-orm";
import { simpleParser, type AddressObject } from "mailparser";
import { db } from "@/lib/db";
import { safeErrorMessage } from "@/lib/errors/scrub";
import { isFeatureEnabled } from "@/lib/features";
import { logger } from "@/lib/logger";
import type { ReceivedMail } from "@/lib/providers/adapters/types";
import { readReportHostSettings } from "./host";
import { ingestDmarcReport, MAX_MESSAGE_BYTES, type ReportOutcome } from "./ingest";
import { dmarcDomainTokens, domains } from "@/lib/db/schema";

const log = logger.child("dmarc:receive");

/** Local parts addressed on `host`, lowercased and deduplicated. */
export function tokensOn(host: string, recipients: string[]): string[] {
  const suffix = `@${host.toLowerCase()}`;
  return [
    ...new Set(
      recipients
        .map((recipient) => (/<([^<>]+)>/.exec(recipient)?.[1] ?? recipient).trim().toLowerCase())
        .filter((recipient) => recipient.endsWith(suffix))
        .map((recipient) => recipient.slice(0, -suffix.length)),
    ),
  ];
}

function addressesIn(fields: (AddressObject | AddressObject[] | undefined)[]): string[] {
  return fields
    .flatMap((field) => (Array.isArray(field) ? field : field ? [field] : []))
    .flatMap((object) => object.value.map((entry) => entry.address ?? ""));
}

/**
 * Reads report mail for each domain whose token it's addressed to. Envelope recipients win;
 * without them, as on a replay, the To and Cc headers. A token no domain holds is dropped and logged.
 */
export async function receiveReportMessage(host: string, raw: Buffer, recipients: string[]): Promise<ReportOutcome[]> {
  let tokens = tokensOn(host, recipients);
  if (tokens.length === 0 && raw.length <= MAX_MESSAGE_BYTES) {
    const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
    tokens = tokensOn(host, addressesIn([parsed.to, parsed.cc]));
  }
  if (tokens.length === 0) {
    log.warn(`dropped report mail on ${host} addressed to no token`);
    return [];
  }

  const rows = await db
    .select({ domain: domains, token: dmarcDomainTokens.token })
    .from(dmarcDomainTokens)
    .innerJoin(domains, eq(domains.id, dmarcDomainTokens.domainId))
    .where(inArray(dmarcDomainTokens.token, tokens));
  const unknown = tokens.length - rows.length;
  if (unknown > 0) log.warn(`dropped report mail for ${unknown} unknown ${unknown === 1 ? "token" : "tokens"} on ${host}`);

  const outcomes: ReportOutcome[] = [];
  for (const { domain } of rows) outcomes.push(await ingestDmarcReport(domain, raw));
  return outcomes;
}

/**
 * Mail a provider announced on the report route. Only the provider the setting names may deliver
 * it, and mail its scanners call a virus, spam or a DMARC failure is treated as a forged report.
 * The provider's copy is deleted either way.
 */
export async function receiveReportMail(providerId: string, mail: ReceivedMail): Promise<{ accepted: number; duplicates: number }> {
  const result = { accepted: 0, duplicates: 0 };
  try {
    const settings = await readReportHostSettings();
    const verdicts = mail.verdicts;
    if (!(await isFeatureEnabled("dmarc_reports"))) {
      log.warn(`dropped report mail ${mail.providerMessageId}: DMARC reports are turned off`);
    } else if (!settings.host || settings.providerId !== providerId) {
      log.warn(`dropped report mail from ${providerId}, which doesn't receive the report host`);
    } else if (verdicts && (verdicts.virus === "fail" || verdicts.spam === "fail" || verdicts.dmarc === "fail")) {
      log.warn(`dropped report mail ${mail.providerMessageId}: the provider's scan failed it`);
    } else {
      const raw = await mail.read();
      if (!raw) log.warn(`the provider's copy of report mail ${mail.providerMessageId} is gone`);
      else {
        for (const outcome of await receiveReportMessage(settings.host, raw, mail.recipients)) {
          if (outcome.outcome === "duplicate") result.duplicates += 1;
          else result.accepted += 1;
        }
      }
    }
  } finally {
    await mail.discard().catch((err) => log.warn(`deleting the provider's copy of ${mail.providerMessageId} failed: ${safeErrorMessage(err)}`));
  }
  return result;
}
