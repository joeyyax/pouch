import { getDomain } from "tldts";
import type { ProposedDnsRecord } from "@/lib/providers/adapters/types";
import { readTxt } from "./dns-check";
import { isSpfValue } from "./spf";

/** Monitoring policy. The report host's `rua` joins it once the host is set up. */
export const DMARC_RECOMMENDED_VALUE = "v=DMARC1; p=none;";

export type DmarcPolicy = "none" | "quarantine" | "reject";
export type DmarcMode = "relaxed" | "strict";

export interface DmarcTags {
  policy: DmarcPolicy;
  subdomainPolicy: DmarcPolicy | null;
  percent: number;
  rua: string[];
  ruf: string[];
  adkim: DmarcMode;
  aspf: DmarcMode;
}

export type DmarcParse = { ok: true; tags: DmarcTags } | { ok: false; reason: string };

export function dmarcName(domain: string): string {
  return `_dmarc.${domain}`;
}

/** The record the setup recommends, optional like every record that doesn't gate verification. */
export function recommendedDmarc(domain: string, reportUri: string | null = null): ProposedDnsRecord {
  return { type: "TXT", name: dmarcName(domain), value: reportUri ? `${DMARC_RECOMMENDED_VALUE} rua=${reportUri};` : DMARC_RECOMMENDED_VALUE, required: false };
}

/** The records plus the recommended DMARC one, unless the list already has a record at that name. */
export function withDmarc(records: ProposedDnsRecord[], domain: string, reportUri: string | null = null): ProposedDnsRecord[] {
  const name = dmarcName(domain);
  return records.some((record) => record.type === "TXT" && record.name.toLowerCase() === name)
    ? records
    : [...records, recommendedDmarc(domain, reportUri)];
}

/** A published record with `uri` added to its `rua`, every other tag as it was. */
export function withReportUri(record: string, uri: string): string {
  const parts = record.split(";").map((part) => part.trim()).filter(Boolean);
  const at = parts.findIndex((part) => /^rua\s*=/i.test(part));
  if (at >= 0) {
    const current = parts[at]!.replace(/^rua\s*=\s*/i, "");
    parts[at] = `rua=${[...current.split(",").map((one) => one.trim()).filter(Boolean), uri].join(",")}`;
  } else {
    const policy = parts.findIndex((part) => /^p\s*=/i.test(part));
    parts.splice(policy >= 0 ? policy + 1 : parts.length, 0, `rua=${uri}`);
  }
  return `${parts.join("; ")};`;
}

/** A published record with its `p` set to `policy`, every other tag as it was. */
export function withPolicy(record: string, policy: DmarcPolicy): string {
  const parts = record.split(";").map((part) => part.trim()).filter(Boolean);
  const at = parts.findIndex((part) => /^p\s*=/i.test(part));
  if (at >= 0) parts[at] = `p=${policy}`;
  else parts.splice(1, 0, `p=${policy}`);
  return `${parts.join("; ")};`;
}

export function isDmarcValue(value: string): boolean {
  return /^\s*v\s*=\s*DMARC1\s*(;|$)/i.test(value);
}

/** The registrable domain, which is where a subdomain without its own record is governed from. */
export function organizationalDomain(name: string): string {
  return getDomain(name.toLowerCase()) ?? name.toLowerCase();
}

function policyOf(value: string | undefined): DmarcPolicy | null {
  const lower = value?.toLowerCase();
  return lower === "none" || lower === "quarantine" || lower === "reject" ? lower : null;
}

function modeOf(value: string | undefined): DmarcMode {
  return value?.toLowerCase() === "s" ? "strict" : "relaxed";
}

function uris(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((uri) => uri.trim().replace(/!\d+[kmgt]?$/i, ""))
    .filter(Boolean);
}

/**
 * Reads a DMARC record's tags. A record without a usable `p` still counts when it has a `rua`,
 * which receivers treat as `p=none`; with neither it can't be read.
 */
export function parseDmarc(value: string): DmarcParse {
  const [version, ...rest] = value.split(";").map((part) => part.trim()).filter(Boolean);
  if (!version || !isDmarcValue(version)) return { ok: false, reason: "it doesn't start with v=DMARC1" };

  const tags = new Map<string, string>();
  for (const part of rest) {
    const match = /^([a-z]+)\s*=\s*(.*)$/i.exec(part);
    if (!match) return { ok: false, reason: `"${part.slice(0, 40)}" isn't a tag=value pair` };
    const key = match[1]!.toLowerCase();
    if (!tags.has(key)) tags.set(key, match[2]!.trim());
  }

  const rua = uris(tags.get("rua"));
  const policy = policyOf(tags.get("p")) ?? (rua.length > 0 ? "none" : null);
  if (!policy) return { ok: false, reason: "p is missing or isn't none, quarantine or reject" };

  const pct = /^\d{1,3}$/.test(tags.get("pct") ?? "") ? Number(tags.get("pct")) : 100;
  return {
    ok: true,
    tags: {
      policy,
      subdomainPolicy: policyOf(tags.get("sp")),
      percent: pct > 100 ? 100 : pct,
      rua,
      ruf: uris(tags.get("ruf")),
      adkim: modeOf(tags.get("adkim")),
      aspf: modeOf(tags.get("aspf")),
    },
  };
}

/** Whether an identity domain aligns with the From domain: exact match when strict, same organizational domain when relaxed. */
export function aligns(identity: string, from: string, mode: DmarcMode): boolean {
  const [a, b] = [identity.toLowerCase(), from.toLowerCase()];
  return mode === "strict" ? a === b : organizationalDomain(a) === organizationalDomain(b);
}

export interface IdentityAlignment {
  /** The domains the setup authenticates mail as. */
  domains: string[];
  mode: DmarcMode;
  aligned: boolean;
}

export interface DmarcAlignment {
  dkim: IdentityAlignment;
  spf: IdentityAlignment;
  /** DMARC passes when either identity aligns. */
  passes: boolean;
}

const DKIM_LABEL = "._domainkey.";

/** DKIM signs as the domain its selector record sits under; SPF is checked on the names holding an SPF record. */
export function authenticationDomains(records: ProposedDnsRecord[]): { dkim: string[]; spf: string[] } {
  const dkim = records.flatMap((record) => {
    const at = record.name.toLowerCase().indexOf(DKIM_LABEL);
    return at < 0 ? [] : [record.name.toLowerCase().slice(at + DKIM_LABEL.length)];
  });
  const spf = records.filter((record) => record.type === "TXT" && isSpfValue(record.value)).map((record) => record.name.toLowerCase());
  return { dkim: [...new Set(dkim)], spf: [...new Set(spf)] };
}

/** Null until the domain has a DKIM or SPF record to measure. */
export function alignmentOf(domain: string, records: ProposedDnsRecord[], tags: Pick<DmarcTags, "adkim" | "aspf">): DmarcAlignment | null {
  const { dkim, spf } = authenticationDomains(records);
  if (dkim.length === 0 && spf.length === 0) return null;
  const dkimAligned = dkim.some((identity) => aligns(identity, domain, tags.adkim));
  const spfAligned = spf.some((identity) => aligns(identity, domain, tags.aspf));
  return {
    dkim: { domains: dkim, mode: tags.adkim, aligned: dkimAligned },
    spf: { domains: spf, mode: tags.aspf, aligned: spfAligned },
    passes: dkimAligned || spfAligned,
  };
}

export type DmarcStatus = "found" | "missing" | "multiple" | "invalid" | "unresolved";

export type DmarcFindingKind =
  | "missing"
  | "multiple_records"
  | "unparseable"
  | "unanswered"
  | "monitoring_only"
  | "dkim_not_aligned"
  | "spf_not_aligned"
  | "alignment_fails"
  | "no_report_address";

export interface DmarcFinding {
  kind: DmarcFindingKind;
  /** `problem` needs a change. `note` is true and needs none. */
  severity: "problem" | "note";
  message: string;
}

export interface DmarcLookup {
  /** The name the record was read at. */
  host: string;
  source: "domain" | "organizational";
  /** Every DMARC record published there. Empty when none. */
  records: string[];
}

/** The DMARC records governing `domain`: its own, then its organizational domain's. Null when a lookup didn't answer. */
export async function readDmarc(domain: string): Promise<DmarcLookup | null> {
  const name = domain.toLowerCase();
  const org = organizationalDomain(name);
  const hosts: { host: string; source: DmarcLookup["source"] }[] =
    org === name ? [{ host: name, source: "domain" }] : [{ host: name, source: "domain" }, { host: org, source: "organizational" }];

  for (const { host, source } of hosts) {
    const txt = await readTxt(dmarcName(host));
    if (txt === null) return null;
    const records = txt.filter(isDmarcValue);
    if (records.length > 0) return { host: dmarcName(host), source, records };
  }
  return { host: dmarcName(name), source: "domain", records: [] };
}

export interface SerializedDmarc {
  status: DmarcStatus;
  /** Where the record was read: the domain's own `_dmarc` name, or its organizational domain's. Null when nothing was found. */
  record_name: string | null;
  source: DmarcLookup["source"] | null;
  /** The record as published. Null unless `status` is `found` or `invalid`. */
  record: string | null;
  policy: DmarcPolicy | null;
  subdomain_policy: DmarcPolicy | null;
  percent: number | null;
  rua: string[];
  ruf: string[];
  adkim: DmarcMode | null;
  aspf: DmarcMode | null;
  alignment: DmarcAlignment | null;
  findings: DmarcFinding[];
  /** The record to publish at `_dmarc.<domain>`: the recommended one, or the published one with the report address added. Null when nothing needs to change. */
  recommended: string | null;
}

const EMPTY: SerializedDmarc = {
  status: "missing",
  record_name: null,
  source: null,
  record: null,
  policy: null,
  subdomain_policy: null,
  percent: null,
  rua: [],
  ruf: [],
  adkim: null,
  aspf: null,
  alignment: null,
  findings: [],
  recommended: null,
};

function alignmentFindings(domain: string, alignment: DmarcAlignment): DmarcFinding[] {
  const { dkim, spf } = alignment;
  if (!alignment.passes) {
    return [
      {
        kind: "alignment_fails",
        severity: "problem",
        message: `Neither DKIM (${dkim.domains.join(", ") || "none"}) nor SPF (${spf.domains.join(", ") || "none"}) aligns with ${domain} under ${dkim.mode === "strict" || spf.mode === "strict" ? "this record's strict alignment" : "relaxed alignment"}, so this domain's mail fails DMARC.`,
      },
    ];
  }
  const findings: DmarcFinding[] = [];
  if (!spf.aligned && spf.domains.length > 0) {
    findings.push({
      kind: "spf_not_aligned",
      severity: "note",
      message: `SPF doesn't align under aspf=s: ${spf.domains.join(", ")} isn't ${domain}. DKIM aligns, so DMARC passes.`,
    });
  }
  if (!dkim.aligned && dkim.domains.length > 0) {
    findings.push({
      kind: "dkim_not_aligned",
      severity: "note",
      message: `DKIM doesn't align under adkim=s: it signs as ${dkim.domains.join(", ")}, not ${domain}. SPF aligns, so DMARC passes.`,
    });
  }
  return findings;
}

/**
 * What the lookup found, as the domain resource reports it. Pure: the lookup, the records and the
 * domain's report address, when the service has one, come in.
 */
export function describeDmarc(domain: string, lookup: DmarcLookup | null, records: ProposedDnsRecord[], reportUri: string | null = null): SerializedDmarc {
  const name = dmarcName(domain);
  const fresh = recommendedDmarc(domain, reportUri).value;

  if (lookup === null) {
    return {
      ...EMPTY,
      status: "unresolved",
      findings: [{ kind: "unanswered", severity: "note", message: `The DMARC lookup for ${name} didn't answer, so a record may still be there. Verify again to check.` }],
    };
  }

  if (lookup.records.length === 0) {
    return {
      ...EMPTY,
      recommended: fresh,
      findings: [
        {
          kind: "missing",
          severity: "problem",
          message: `No DMARC record is published at ${name}. Sending works without one, and Gmail and Yahoo require one from bulk senders.`,
        },
      ],
    };
  }

  const located = { record_name: lookup.host, source: lookup.source };

  if (lookup.records.length > 1) {
    return {
      ...EMPTY,
      ...located,
      status: "multiple",
      recommended: fresh,
      findings: [
        {
          kind: "multiple_records",
          severity: "problem",
          message: `${lookup.records.length} DMARC records are published at ${lookup.host}. Receivers ignore all of them, so the domain has no policy. Remove all but one.`,
        },
      ],
    };
  }

  const record = lookup.records[0]!;
  const parsed = parseDmarc(record);
  if (!parsed.ok) {
    return {
      ...EMPTY,
      ...located,
      status: "invalid",
      record,
      recommended: fresh,
      findings: [
        { kind: "unparseable", severity: "problem", message: `The DMARC record at ${lookup.host} can't be read: ${parsed.reason}. Receivers ignore it. Replace it with a valid record.` },
      ],
    };
  }

  const { tags } = parsed;
  const governing = lookup.source === "organizational" ? (tags.subdomainPolicy ?? tags.policy) : tags.policy;
  const alignment = alignmentOf(domain, records, tags);
  const findings: DmarcFinding[] = [];
  if (governing === "none") {
    findings.push({
      kind: "monitoring_only",
      severity: "note",
      message: "p=none is monitoring only. Mail that fails DMARC is delivered as usual. Move to quarantine or reject once your mail passes.",
    });
  }
  if (alignment) findings.push(...alignmentFindings(domain, alignment));
  // An organizational domain's record is someone else's to change, so it gets no merged record.
  const missingReportUri = reportUri !== null && lookup.source === "domain" && !tags.rua.some((uri) => uri.toLowerCase() === reportUri.toLowerCase());
  if (missingReportUri) {
    findings.push({
      kind: "no_report_address",
      severity: "note",
      message: `Reports about ${domain} don't come here yet. Add ${reportUri} to the record's rua to see who sends as the domain.`,
    });
  }

  return {
    status: "found",
    ...located,
    record,
    policy: tags.policy,
    subdomain_policy: tags.subdomainPolicy,
    percent: tags.percent,
    rua: tags.rua,
    ruf: tags.ruf,
    adkim: tags.adkim,
    aspf: tags.aspf,
    alignment,
    findings,
    recommended: missingReportUri ? withReportUri(record, reportUri) : null,
  };
}

/** Reads the domain's DMARC state live and describes it against its records. */
export async function checkDmarc(domain: string, records: ProposedDnsRecord[], reportUri: string | null = null): Promise<SerializedDmarc> {
  return describeDmarc(domain, await readDmarc(domain), records, reportUri);
}

/**
 * Whether a domain's DMARC state satisfies Gmail and Yahoo's bulk-sender rule, which asks for a
 * record at any policy. An unanswered lookup passes: only a definite absence refuses.
 */
export function dmarcBlocksBulk(dmarc: SerializedDmarc): boolean {
  return dmarc.status === "missing" || dmarc.status === "multiple" || dmarc.status === "invalid";
}
