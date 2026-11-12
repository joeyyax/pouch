import { recordActivity } from "@/lib/activity/record";
import { dbNow } from "@/lib/db/clock";
import { db } from "@/lib/db";
import { dnsProviderRecords } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { logger } from "@/lib/logger";
import type { ProposedDnsRecord } from "@/lib/providers/adapters/types";
import { computeDnsPlan, normalizeName, resolveDnsZoneContext, type DnsPlanStatus } from "./dns-plan";
import { domainFor, type DomainCaller, type DomainRow } from ".";
import { safeErrorMessage } from "@/lib/errors/scrub";
import { withSpfMechanisms } from "./spf";

/**
 * This is the first code in the project that can change somebody's DNS. Every write below goes
 * through the three backstops in docs/design/registrar-integration.md — permission model:
 *
 *   1. The only records ever handed to `upsertRecords` are the domain's own stored
 *      `dnsRecords` (what `Adapter.domain.create()`/`verify()` proposed) or, for a pending
 *      provider move, `pendingDnsRecords` — loaded server-side from the domain id either
 *      way. Nothing freeform, from an API body or a form, ever reaches this far.
 *   2. Immediately before writing a step, its record is re-checked against that same stored set
 *      — belt and suspenders on top of (1), so a future bug upstream still can't slip a record
 *      through.
 *   3. A conflict is never written, under any retry: this function never calls `upsertRecords`
 *      for a `conflict` step, full stop.
 */

const log = logger.child("domains:dns-apply");

export type DnsApplyStatus = "applied" | "skipped" | "conflict" | "failed";

export interface DnsApplyStep {
  record: ProposedDnsRecord;
  status: DnsApplyStatus;
  /** One sentence, same shape as a plan step's `reason`. */
  reason: string;
  /** Set only when `status` is `failed`. */
  error?: string;
}

export interface DnsApplyResult {
  status: DnsPlanStatus;
  zoneName: string | null;
  steps: DnsApplyStep[];
  detail: string | null;
}

/**
 * Re-computes the plan for `domainId` from the live zone — never a plan the caller already has
 * in hand, since a stale plan is exactly the gap that would let a since-changed live record get
 * overwritten — and applies every `create` and `merge` step. `already_correct` steps are no-ops;
 * `conflict` steps are reported, never written.
 *
 * Idempotent by construction: applying twice re-reads the live zone both times, so anything the
 * first run wrote reads back as `already_correct` on the second and nothing is written again.
 *
 * Failure is per-step. A step's provider error is recorded as `failed` and the rest of the plan
 * keeps going — nothing already applied is rolled back, since every write here is additive.
 */
export async function applyDnsPlan(caller: DomainCaller, domainId: string): Promise<DnsApplyResult> {
  const domain = await domainFor(caller, domainId);
  return applyRequiredRecords(caller, domain, domain.dnsRecords, domain.providerId);
}

/**
 * Same engine, for a pending provider move's required records (#212) — a pending
 * binding's records get a plan and can be applied exactly like an ordinary domain's, alongside
 * whatever the current account still has published. The live zone read, the backstops and the
 * provenance write are all unchanged; only which record set counts as "required" differs.
 *
 * Never called from cutover itself (`worker/verify.ts`): applying is something an operator does
 * while a move is pending, not a side effect of the move completing.
 */
export async function applyPendingDnsPlan(caller: DomainCaller, domainId: string): Promise<DnsApplyResult> {
  const domain = await domainFor(caller, domainId);
  if (!domain.pendingProviderId) {
    return { status: "ready", zoneName: null, steps: [], detail: null };
  }
  return applyRequiredRecords(caller, domain, domain.pendingDnsRecords, domain.pendingProviderId);
}

async function applyRequiredRecords(
  caller: DomainCaller,
  domain: DomainRow,
  records: ProposedDnsRecord[],
  providerId: string | null,
): Promise<DnsApplyResult> {
  const ctx = await resolveDnsZoneContext(caller.organizationId, domain.name);
  if (ctx.status !== "ready" || !ctx.provider || !ctx.zone || !ctx.account) {
    return { status: ctx.status, zoneName: ctx.zoneName, steps: [], detail: ctx.detail };
  }

  // Backstop 1: the only records this run will ever consider are the domain's own stored,
  // required records — computed by the provider at create/verify time, never a caller input.
  const requiredRecords = records.filter((record) => record.required);

  let liveRecords;
  try {
    liveRecords = await ctx.provider.getRecords(ctx.zone);
  } catch (err) {
    log.warn(`getRecords(${ctx.zone.name}) failed: ${safeErrorMessage(err)}`);
    return { status: "unreachable", zoneName: ctx.zone.name, steps: [], detail: "Couldn't read the live zone." };
  }

  const plan = computeDnsPlan(requiredRecords, liveRecords);

  const steps: DnsApplyStep[] = [];
  for (const step of plan) {
    if (step.verdict === "already_correct") {
      steps.push({ record: step.record, status: "skipped", reason: step.reason });
      continue;
    }
    if (step.verdict === "conflict") {
      steps.push({ record: step.record, status: "conflict", reason: step.reason });
      continue;
    }

    // Backstop 2: re-check this exact record against the domain's stored required set,
    // immediately before it's written — redundant with (1) above by design.
    const isOwnRecord = requiredRecords.some(
      (required) =>
        required.type === step.record.type &&
        normalizeName(required.name) === normalizeName(step.record.name) &&
        required.value === step.record.value &&
        (required.priority ?? 0) === (step.record.priority ?? 0),
    );
    if (!isOwnRecord) {
      steps.push({
        record: step.record,
        status: "failed",
        reason: step.reason,
        error: "This record isn't part of the domain's own required set. Refusing to write it.",
      });
      continue;
    }

    // For a merge, the final content is what's already published plus the missing mechanisms —
    // never a value built any other way. For a create, the record is written as proposed.
    const observed = step.observed[0];
    const finalRecord: ProposedDnsRecord =
      step.verdict === "merge" && step.merge && observed
        ? { ...step.record, value: withSpfMechanisms(observed.value, step.merge.mechanisms) }
        : step.record;
    const writtenValue = step.verdict === "merge" && step.merge ? step.merge.mechanisms : step.record.value;

    let writeResults;
    try {
      writeResults = await ctx.provider.upsertRecords(ctx.zone, [finalRecord]);
    } catch (err) {
      steps.push({ record: step.record, status: "failed", reason: step.reason, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const result = writeResults[0];
    if (!result || result.status === "failed") {
      steps.push({
        record: step.record,
        status: "failed",
        reason: step.reason,
        error: result && "error" in result ? result.error : "The provider didn't confirm the write.",
      });
      continue;
    }

    await db.insert(dnsProviderRecords).values({
      id: newId("dnsProviderRecord"),
      organizationId: caller.organizationId,
      domainId: domain.id,
      dnsProviderAccountId: ctx.account.id,
      providerId,
      zoneName: ctx.zone.name,
      type: step.record.type,
      name: normalizeName(step.record.name),
      writtenValue,
      appliedAt: await dbNow(),
    });

    steps.push({ record: step.record, status: "applied", reason: step.reason });
  }

  const applied = steps.filter((step) => step.status === "applied").length;
  if (applied > 0) {
    await recordActivity({
      organizationId: caller.organizationId,
      action: "domain.dns.applied",
      actor: caller.actor,
      appliesTo: domain.id,
      subjectLabel: domain.name,
      metadata: {
        applied,
        skipped: steps.filter((step) => step.status === "skipped").length,
        conflicts: steps.filter((step) => step.status === "conflict").length,
        failed: steps.filter((step) => step.status === "failed").length,
      },
    });
  }

  return { status: "ready", zoneName: ctx.zone.name, steps, detail: null };
}
