import { asc, eq } from "drizzle-orm";
import { recordActivity } from "@/lib/activity/record";
import { db } from "@/lib/db";
import { dnsProviderRecords, type DnsProviderRecordRow } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import type { DnsRecordType, ObservedDnsRecord, ProposedDnsRecord } from "@/lib/providers/adapters/types";
import { isSpfValue, spfAllTerm, spfMechanisms } from "./spf";
import { normalizeName, normalizeValue, resolveDnsZoneContext, valuesMatch, type DnsPlanStatus } from "./dns-plan";
import { domainFor, type DomainCaller } from ".";
import { brand } from "@/lib/brand";
import { safeErrorMessage } from "@/lib/errors/scrub";

/**
 * Removal of what Pouch wrote — the slice of docs/design/registrar-integration.md most likely to
 * cause real harm if it's wrong, so it repeats the same read-before-write discipline
 * `dns-apply.ts` uses for writes, in reverse:
 *
 *   1. Only rows in `dns_provider_records` for this domain are ever candidates. Nothing here
 *      guesses from shape — see `docs/design/registrar-integration.md`, "Provenance".
 *   2. Every row is re-checked against the live zone immediately before it's touched. A row
 *      whose live value no longer matches what we wrote is refused, not deleted.
 *   3. A merged SPF record is edited, never deleted: only the mechanisms `written_value` names
 *      come out, everything else at that name stays. If subtracting them would leave the record
 *      malformed, the row is refused instead.
 *
 * Nothing here runs on its own — `removeDnsProvenance` is only ever called from an explicit,
 * confirmed dashboard action (see `app/(app)/domains/dns-cleanup.tsx`), never from domain delete
 * or a provider move.
 */

const log = logger.child("domains:dns-cleanup");

export type DnsCleanupAction = "delete" | "edit";
export type DnsCleanupStatus = "removable" | "refused";

export interface DnsCleanupStep {
  id: string;
  type: DnsRecordType;
  name: string;
  writtenValue: string;
  action: DnsCleanupAction;
  status: DnsCleanupStatus;
  /** One sentence, same shape as a reconciliation plan step's `reason`. */
  reason: string;
  /** Set only when `action` is `edit`: the record's value once our mechanisms come out. */
  resultingValue: string | null;
}

export interface DnsCleanupPlan {
  status: DnsPlanStatus;
  zoneName: string | null;
  steps: DnsCleanupStep[];
  detail: string | null;
}

/** Matches a provenance row's `written_value` against what a required record currently asks for, for an MX row's priority. */
function requiredFor(row: DnsProviderRecordRow, requiredRecords: ProposedDnsRecord[]): ProposedDnsRecord | undefined {
  return requiredRecords.find(
    (record) => record.type === row.type && normalizeName(record.name) === normalizeName(row.name),
  );
}

/**
 * A plain record (never SPF-merged): the live value has to match `written_value` exactly, the
 * same normalization the reconciliation plan uses. The provenance table doesn't carry an MX
 * priority, so a still-required record's current priority stands in for it — the best available
 * check without a schema change, and it fails closed: an MX no longer required refuses rather
 * than guesses.
 */
function rowMatchesLive(row: DnsProviderRecordRow, live: ObservedDnsRecord, requiredRecords: ProposedDnsRecord[]): boolean {
  const required = requiredFor(row, requiredRecords);
  const proxy: ProposedDnsRecord = { type: row.type, name: row.name, value: row.writtenValue, priority: required?.priority, required: true };
  return valuesMatch(proxy, live);
}

/**
 * Subtracts exactly the mechanisms `written_value` names from what's live, the merge engine in
 * `dns-plan.ts` run in reverse. Refuses rather than guesses when a mechanism Pouch added is
 * already gone (a hand edit since), or when the result wouldn't parse as SPF.
 */
function classifySpfSubtraction(row: DnsProviderRecordRow, live: ObservedDnsRecord, base: { id: string; type: DnsRecordType; name: string; writtenValue: string }): DnsCleanupStep {
  const writtenTerms = row.writtenValue.trim().split(/\s+/).filter((term) => term.length > 0);
  const liveTerms = spfMechanisms(live.value);

  const missing = writtenTerms.filter((term) => !liveTerms.includes(term));
  if (missing.length > 0) {
    return {
      ...base,
      action: "edit",
      status: "refused",
      resultingValue: null,
      reason: `${live.name} has changed since ${brand.name} wrote it — ${missing.join(" ")} is already gone. Left alone.`,
    };
  }

  const remaining = liveTerms.filter((term) => !writtenTerms.includes(term));
  const allTerm = spfAllTerm(live.value);
  const resultingValue = ["v=spf1", ...remaining, ...(allTerm ? [allTerm] : [])].join(" ");

  // Removing only our own mechanisms can't break the record's syntax — this is a backstop
  // against a bug upstream, same posture as dns-apply.ts's belt-and-suspenders re-check.
  if (!isSpfValue(resultingValue)) {
    return {
      ...base,
      action: "edit",
      status: "refused",
      resultingValue: null,
      reason: `Removing ${brand.name}'s mechanisms from ${live.name} would leave a malformed SPF record. Left alone.`,
    };
  }

  return {
    ...base,
    action: "edit",
    status: "removable",
    resultingValue,
    reason:
      remaining.length > 0
        ? `Removes ${writtenTerms.join(" ")} from ${live.name}. ${remaining.join(" ")} stays.`
        : `Removes ${writtenTerms.join(" ")} from ${live.name}. Nothing else was added, so the record keeps just its base policy.`,
  };
}

function classifyCleanupRow(row: DnsProviderRecordRow, live: ObservedDnsRecord[], requiredRecords: ProposedDnsRecord[]): DnsCleanupStep {
  const base = { id: row.id, type: row.type, name: row.name, writtenValue: row.writtenValue };
  const name = normalizeName(row.name);
  const atName = live.filter((record) => record.type === row.type && normalizeName(record.name) === name);

  if (atName.length === 0) {
    return { ...base, action: "delete", status: "refused", resultingValue: null, reason: "Nothing is published at this name anymore. There's nothing to remove." };
  }

  if (atName.length === 1) {
    const single = atName[0]!;
    if (rowMatchesLive(row, single, requiredRecords)) {
      return { ...base, action: "delete", status: "removable", resultingValue: null, reason: `Matches exactly what ${brand.name} wrote to ${single.name}. Will be deleted.` };
    }
    if (row.type === "TXT" && isSpfValue(single.value)) {
      return classifySpfSubtraction(row, single, base);
    }
    return { ...base, action: "delete", status: "refused", resultingValue: null, reason: `${row.name} has changed since ${brand.name} wrote it. Left alone.` };
  }

  // More than one record at the name now — only ever act if exactly one is a clean SPF
  // subtraction target, same posture dns-plan.ts takes for a merge among several records.
  if (row.type === "TXT") {
    const spfCandidates = atName.filter((record) => isSpfValue(record.value));
    if (spfCandidates.length === 1) return classifySpfSubtraction(row, spfCandidates[0]!, base);
  }
  return { ...base, action: "delete", status: "refused", resultingValue: null, reason: `More than one record is published at ${row.name} now. Left alone — this needs a human.` };
}

/**
 * Whether a provenance row is still part of the domain's currently required records — same
 * (type, name), and the same value (or, for a merged row, mechanisms every one of which is
 * still required). A row that isn't was written for a required set the domain has since moved
 * off — the previous account in a provider move that's since cut over, most commonly.
 *
 * This is the fallback for a row with no `provider_id` (#239) — written before that
 * column existed, so there's no way to know which account it came from and guessing would be
 * worse than admitting it. It's correct after a cutover, and correctly yields nothing while a
 * move is pending, but a row that stops being required for a reason other than a cutover — a
 * provider changing its required set, say — also reads as "previous account" here. Every other
 * backstop in `removeDnsProvenance` still applies, so a misclassification here is never unsafe,
 * only mislabeled.
 */
function isCurrentlyRequired(row: DnsProviderRecordRow, requiredRecords: ProposedDnsRecord[]): boolean {
  const required = requiredFor(row, requiredRecords);
  if (!required) return false;
  if (required.merge === "spf") {
    const writtenTerms = row.writtenValue.trim().split(/\s+/).filter((term) => term.length > 0);
    const requiredTerms = spfMechanisms(required.value);
    return writtenTerms.every((term) => requiredTerms.includes(term));
  }
  return normalizeValue(row.writtenValue) === normalizeValue(required.value);
}

/**
 * Rows written for the account this domain moved off of. A row carrying `provider_id`
 * (#239) is scoped directly: previous account means simply "not the domain's current account,"
 * no inference needed. A row with no `provider_id` — written before that column existed
 * — falls back to `isCurrentlyRequired`, the only thing that can classify it; see that function's
 * comment for where the inference is weaker than a column.
 *
 * Pure, and what the post-cutover "clean up N records from the previous account" action (#212)
 * scopes `planDnsCleanup`/`removeDnsProvenance` to, so a still-required, still-live record from
 * the account the domain now sends through is never a candidate.
 */
export function previousAccountProvenance(
  provenance: DnsProviderRecordRow[],
  requiredRecords: ProposedDnsRecord[],
  currentProviderId: string,
): DnsProviderRecordRow[] {
  return provenance.filter((row) =>
    row.providerId !== null
      ? row.providerId !== currentProviderId
      : !isCurrentlyRequired(row, requiredRecords),
  );
}

/**
 * Pure: given the domain's provenance rows, what's live, and the domain's currently required
 * records (for an MX row's priority), classifies each row. No I/O, so this is the part fixtures
 * exercise directly.
 */
export function computeDnsCleanupPlan(
  provenance: DnsProviderRecordRow[],
  liveRecords: ObservedDnsRecord[],
  requiredRecords: ProposedDnsRecord[],
): DnsCleanupStep[] {
  return provenance.map((row) => classifyCleanupRow(row, liveRecords, requiredRecords));
}

/**
 * `"all"` is #211's original scope — every row the domain's provenance holds, the default and
 * what the plain "Clean up DNS records" dashboard card still uses. `"previous_account"` is
 * #212's addition: only rows `previousAccountProvenance` says aren't part of what the domain
 * requires today, so a record the domain still sends through is never offered for removal.
 */
export type DnsCleanupScope = "all" | "previous_account";

/**
 * Builds the cleanup plan for one domain: every row `dns_provider_records` holds for it (or, with
 * `scope: "previous_account"`, only the ones stale relative to what's required today), checked
 * against a fresh, authoritative read of the live zone. Read-only — never called on its own by
 * anything but the confirmation screen, and `removeDnsProvenance` below re-derives its own plan
 * rather than trusting one a caller already has in hand.
 */
export async function planDnsCleanup(caller: DomainCaller, domainId: string, scope: DnsCleanupScope = "all"): Promise<DnsCleanupPlan> {
  const domain = await domainFor(caller, domainId);

  const allProvenance = await db
    .select()
    .from(dnsProviderRecords)
    .where(eq(dnsProviderRecords.domainId, domain.id))
    .orderBy(asc(dnsProviderRecords.appliedAt));
  const provenance = scope === "previous_account" ? previousAccountProvenance(allProvenance, domain.dnsRecords, domain.providerId) : allProvenance;
  if (provenance.length === 0) return { status: "ready", zoneName: null, steps: [], detail: null };

  const ctx = await resolveDnsZoneContext(caller.organizationId, domain.name);
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

  return { status: "ready", zoneName: ctx.zone.name, steps: computeDnsCleanupPlan(provenance, liveRecords, domain.dnsRecords), detail: null };
}

export type DnsCleanupOutcome = "removed" | "refused" | "failed";

export interface DnsCleanupResultStep {
  id: string;
  type: DnsRecordType;
  name: string;
  action: DnsCleanupAction;
  outcome: DnsCleanupOutcome;
  reason: string;
  error?: string;
}

export interface DnsCleanupResult {
  status: DnsPlanStatus;
  zoneName: string | null;
  steps: DnsCleanupResultStep[];
  detail: string | null;
}

/**
 * Removes every row this domain's provenance holds that's still safe to touch — or, with
 * `scope: "previous_account"`, only the rows stale relative to what's required today (#212's
 * post-cutover cleanup action). Never called as a side effect of anything else — the caller is
 * the confirmed dashboard action, full stop, and cutover completing in `worker/verify.ts` never
 * calls this.
 *
 * Re-reads the live zone and re-classifies from scratch, exactly like `applyDnsPlan` does for
 * writes: a plan the caller already rendered is not trusted, since a stale plan is the exact gap
 * that would let a since-changed record get removed blind. A `refused` row is never touched. A
 * `removable` row's provenance is dropped only after the provider confirms the change — deleting
 * the whole record for a plain write, or writing the subtracted value back for an SPF merge.
 */
export async function removeDnsProvenance(caller: DomainCaller, domainId: string, scope: DnsCleanupScope = "all"): Promise<DnsCleanupResult> {
  const domain = await domainFor(caller, domainId);

  const allProvenance = await db.select().from(dnsProviderRecords).where(eq(dnsProviderRecords.domainId, domain.id));
  const provenance = scope === "previous_account" ? previousAccountProvenance(allProvenance, domain.dnsRecords, domain.providerId) : allProvenance;
  if (provenance.length === 0) return { status: "ready", zoneName: null, steps: [], detail: null };

  const ctx = await resolveDnsZoneContext(caller.organizationId, domain.name);
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

  const plan = computeDnsCleanupPlan(provenance, liveRecords, domain.dnsRecords);

  const results: DnsCleanupResultStep[] = [];
  for (const step of plan) {
    if (step.status === "refused") {
      results.push({ id: step.id, type: step.type, name: step.name, action: step.action, outcome: "refused", reason: step.reason });
      continue;
    }

    try {
      if (step.action === "delete") {
        await ctx.provider.removeRecords(ctx.zone, [{ type: step.type, name: normalizeName(step.name) }]);
      } else {
        // The reverse of dns-apply.ts's merge write: publish the value with our mechanisms
        // subtracted, additive infrastructure reused to make a smaller edit.
        const finalRecord: ProposedDnsRecord = { type: step.type, name: step.name, value: step.resultingValue!, required: true };
        const writeResults = await ctx.provider.upsertRecords(ctx.zone, [finalRecord]);
        const result = writeResults[0];
        if (!result || result.status === "failed") {
          throw new Error(result && "error" in result ? result.error : "The provider didn't confirm the write.");
        }
      }
    } catch (err) {
      results.push({
        id: step.id,
        type: step.type,
        name: step.name,
        action: step.action,
        outcome: "failed",
        reason: step.reason,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    await db.delete(dnsProviderRecords).where(eq(dnsProviderRecords.id, step.id));
    results.push({ id: step.id, type: step.type, name: step.name, action: step.action, outcome: "removed", reason: step.reason });
  }

  const removed = results.filter((result) => result.outcome === "removed").length;
  if (removed > 0) {
    await recordActivity({
      organizationId: caller.organizationId,
      action: "domain.dns.removed",
      actor: caller.actor,
      appliesTo: domain.id,
      subjectLabel: domain.name,
      metadata: {
        removed,
        refused: results.filter((result) => result.outcome === "refused").length,
        failed: results.filter((result) => result.outcome === "failed").length,
      },
    });
  }

  return { status: "ready", zoneName: ctx.zone.name, steps: results, detail: null };
}
