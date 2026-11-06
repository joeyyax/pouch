import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dnsProviderAccounts, type DnsProviderAccountRow } from "@/lib/db/schema";
import { dnsProviderFor } from "@/lib/dns-providers/accounts";
import type { DnsProvider, DnsZone } from "@/lib/dns-providers/types";
import { logger } from "@/lib/logger";
import type { ObservedDnsRecord, ProposedDnsRecord } from "@/lib/providers/adapters/types";
import { isSpfValue, spfLookups, spfMechanisms, SPF_LOOKUP_LIMIT } from "./spf";
import { safeErrorMessage } from "@/lib/errors/scrub";

/**
 * The reconciliation plan: what a domain's required records need against the live zone, read
 * through the DNS provider's own API (`DnsProvider.getRecords`) rather than #190's
 * public-resolver read. #190 answers "what does the internet see"; this answers "is it safe to
 * write here", which needs an authoritative, uncached read the same call makes twice in a row
 * agree with itself. Nothing here writes — see docs/design/registrar-integration.md.
 */

const log = logger.child("domains:dns-plan");

export type DnsPlanVerdict = "create" | "already_correct" | "merge" | "conflict";

export interface DnsPlanMerge {
  /** Mechanisms missing from what's already published, in the order they'd be appended. */
  mechanisms: string;
  /** Total SPF lookups after merging — what's already there plus what this would add. */
  lookups: number;
}

export interface DnsPlanStep {
  record: ProposedDnsRecord;
  verdict: DnsPlanVerdict;
  /** What's live at this (type, name) right now. Empty on `create`. */
  observed: ObservedDnsRecord[];
  /** Set only when verdict is `merge`. */
  merge?: DnsPlanMerge;
  /** One sentence, for display next to the step. */
  reason: string;
}

export type DnsPlanStatus = "ready" | "no_account" | "zone_not_found" | "unreachable";

export interface DnsPlan {
  status: DnsPlanStatus;
  zoneName: string | null;
  steps: DnsPlanStep[];
  /** Set only when status is `unreachable`. */
  detail: string | null;
}

export function normalizeName(name: string): string {
  return name.replace(/\.$/, "").toLowerCase();
}

export function normalizeValue(value: string): string {
  return value.replace(/\.$/, "").toLowerCase();
}

/**
 * Same normalization `dns-check.ts` uses for a live answer: case and trailing dot only, TXT
 * compared verbatim. Exported for `dns-cleanup.ts` (#211), which re-checks a written record
 * against the live zone the same way this plan does.
 */
export function valuesMatch(required: ProposedDnsRecord, live: ObservedDnsRecord): boolean {
  if (required.type === "MX") {
    return normalizeValue(required.value) === normalizeValue(live.value) && (required.priority ?? 0) === (live.priority ?? 0);
  }
  if (required.type === "TXT") return required.value === live.value;
  return normalizeValue(required.value) === normalizeValue(live.value);
}

/**
 * `merge === "spf"`, an SPF record already at the name. Appends only the mechanisms this record
 * needs that aren't already there — never touches what's published. `spfMechanisms`/`spfLookups`
 * are the same primitives `spfMergeGuidance` (#83/#200) is built on, so the lookup count here and
 * the one shown in the guided-setup diff can't drift apart.
 */
function classifySpfMerge(required: ProposedDnsRecord, live: ObservedDnsRecord, atName: ObservedDnsRecord[]): DnsPlanStep {
  const existing = spfMechanisms(live.value);
  const wanted = spfMechanisms(required.value);
  const missing = wanted.filter((term) => !existing.includes(term));

  if (missing.length === 0) {
    return {
      record: required,
      verdict: "already_correct",
      observed: [live],
      reason: `${live.name} already carries every mechanism this record needs.`,
    };
  }

  const lookups = spfLookups([...existing, ...missing]);
  if (lookups > SPF_LOOKUP_LIMIT) {
    return {
      record: required,
      verdict: "conflict",
      observed: atName,
      reason: `Merging would need ${lookups} of the ${SPF_LOOKUP_LIMIT} DNS lookups SPF allows. This needs a human — see the record list.`,
    };
  }

  return {
    record: required,
    verdict: "merge",
    observed: [live],
    merge: { mechanisms: missing.join(" "), lookups },
    reason: `${live.name} already has an SPF record. Add ${missing.join(" ")} to it — the existing mechanisms stay untouched.`,
  };
}

/** Classifies one required record against everything live at its (type, name). */
function classifyRecord(required: ProposedDnsRecord, live: ObservedDnsRecord[]): DnsPlanStep {
  const name = normalizeName(required.name);
  const atName = live.filter((record) => record.type === required.type && normalizeName(record.name) === name);

  if (atName.length === 0) {
    return { record: required, verdict: "create", observed: [], reason: "Nothing published at this name yet." };
  }

  if (atName.length === 1) {
    const single = atName[0]!;
    if (valuesMatch(required, single)) {
      return { record: required, verdict: "already_correct", observed: [single], reason: "Already published, matches exactly." };
    }
    if (required.merge === "spf" && isSpfValue(single.value)) {
      return classifySpfMerge(required, single, atName);
    }
    return {
      record: required,
      verdict: "conflict",
      observed: atName,
      reason: "Something else is already published at this name. This needs a human — see the record list.",
    };
  }

  // More than one record already at the name — a record set, on a provider like Route53 that
  // models several values under one (name, type), or several independent records on one that
  // doesn't. If this required value is already one of them, that's the healthy multi-value case
  // (two mail exchangers, two unrelated TXT records) and never a write: the other values at the
  // name are somebody else's, untouched either way. This never turns into a `create` — writing a
  // new value into a name that already holds others without disturbing them needs a
  // read-modify-write upsert no adapter has today (see `route53.ts#upsertRecords`), so anything
  // that isn't an exact match here stays a conflict.
  const match = atName.find((record) => valuesMatch(required, record));
  if (match) {
    return {
      record: required,
      verdict: "already_correct",
      observed: [match],
      reason: `Already published among the ${atName.length} records at this name. The others are untouched.`,
    };
  }

  // Still mergeable if exactly one of the others is the SPF record this one would merge into;
  // anything less clean is a conflict, never a guess.
  if (required.merge === "spf") {
    const spfRecords = atName.filter((record) => isSpfValue(record.value));
    if (spfRecords.length === 1) return classifySpfMerge(required, spfRecords[0]!, atName);
  }

  return {
    record: required,
    verdict: "conflict",
    observed: atName,
    reason: "More than one record is already published at this name, and this one isn't among them. This needs a human — see the record list.",
  };
}

/**
 * Pure: given a domain's required records and what the live zone actually holds, computes the
 * plan. No I/O, so it's the part fixtures exercise directly. Only records this domain actually
 * requires are planned — an optional record (MAIL FROM's MX/TXT, say) never blocks or appears
 * here, same as it never gates verification.
 */
export function computeDnsPlan(requiredRecords: ProposedDnsRecord[], liveRecords: ObservedDnsRecord[]): DnsPlanStep[] {
  return requiredRecords.filter((record) => record.required).map((record) => classifyRecord(record, liveRecords));
}

/** What resolving a domain's DNS provider account and zone found. `ready` is the only status that carries a usable provider/zone. */
export interface DnsZoneContext {
  status: DnsPlanStatus;
  zoneName: string | null;
  detail: string | null;
  account: DnsProviderAccountRow | null;
  provider: DnsProvider | null;
  zone: DnsZone | null;
}

/**
 * Finds the organization's DNS provider account and its zone for a domain — the read shared by
 * `planDomainDns` (display) and `applyDnsPlan` (write, #210), so the write path resolves the
 * account and zone exactly the same way the plan it re-checks against did.
 *
 * One DNS provider account per organization for v1 (docs/design/registrar-integration.md), so
 * the oldest one is used without a picker.
 */
export async function resolveDnsZoneContext(organizationId: string, domainName: string): Promise<DnsZoneContext> {
  const [account] = await db
    .select()
    .from(dnsProviderAccounts)
    .where(eq(dnsProviderAccounts.organizationId, organizationId))
    .orderBy(asc(dnsProviderAccounts.createdAt))
    .limit(1);

  if (!account) {
    return { status: "no_account", zoneName: null, detail: null, account: null, provider: null, zone: null };
  }

  const provider = dnsProviderFor(account);

  let zone: DnsZone | null;
  try {
    zone = await provider.findZone(domainName);
  } catch (err) {
    log.warn(`findZone(${domainName}) failed: ${safeErrorMessage(err)}`);
    return {
      status: "unreachable",
      zoneName: null,
      detail: "Couldn't reach the DNS provider.",
      account,
      provider,
      zone: null,
    };
  }

  if (!zone) {
    return { status: "zone_not_found", zoneName: null, detail: null, account, provider, zone: null };
  }

  return { status: "ready", zoneName: zone.name, detail: null, account, provider, zone };
}

/**
 * Builds the plan for one domain: resolves the organization's DNS provider account, reads the
 * live zone through it, and classifies. Takes a domain id's required records as already computed
 * by `Adapter.domain.create()`/`verify()` (`domain.dnsRecords`) — never a freeform record list,
 * so a caller can't get an arbitrary set of records checked, let alone written later.
 */
export async function planDomainDns(
  organizationId: string,
  domain: { name: string; dnsRecords: ProposedDnsRecord[] },
): Promise<DnsPlan> {
  const ctx = await resolveDnsZoneContext(organizationId, domain.name);
  if (ctx.status !== "ready" || !ctx.provider || !ctx.zone) {
    return { status: ctx.status, zoneName: ctx.zoneName, steps: [], detail: ctx.detail };
  }

  let liveRecords: ObservedDnsRecord[];
  try {
    liveRecords = await ctx.provider.getRecords(ctx.zone);
  } catch (err) {
    log.warn(`getRecords(${ctx.zone.name}) failed: ${safeErrorMessage(err)}`);
    return { status: "unreachable", zoneName: ctx.zone.name, steps: [], detail: "Couldn't read the live zone." };
  }

  return { status: "ready", zoneName: ctx.zone.name, steps: computeDnsPlan(domain.dnsRecords, liveRecords), detail: null };
}
