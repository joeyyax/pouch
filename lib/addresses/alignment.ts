import { readTxt } from "@/lib/domains/dns-check";
import { isDmarcValue } from "@/lib/domains/dmarc";

function dmarcRecord(records: string[]): string | null {
  return records.find(isDmarcValue) ?? null;
}

/**
 * Whether the DMARC policy governing `host` asks for strict DKIM alignment (`adkim=s`), which a
 * signature for the parent domain can't meet. Reads the nearest `_dmarc` record walking up from
 * `host`. An unanswered lookup reads as relaxed.
 */
export async function requiresStrictDkim(host: string): Promise<boolean> {
  const labels = host.toLowerCase().split(".");
  for (let start = 0; start <= labels.length - 2; start += 1) {
    const records = await readTxt(`_dmarc.${labels.slice(start).join(".")}`);
    if (records === null) return false;
    const record = dmarcRecord(records);
    if (record) return /(^|;)\s*adkim\s*=\s*s\s*(;|$)/i.test(record);
  }
  return false;
}
