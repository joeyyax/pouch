/** Turns a legacy provider into a tenant of a shared provider on the same provider, in place. */
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, organizations, providers } from "@/lib/db/schema";
import { recordActivity } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import { ApiError } from "@/lib/api/errors";
import { safeErrorMessage } from "@/lib/errors/scrub";
import { newId } from "@/lib/ids";
import { capabilitiesOf, conversionPlanOf } from "@/lib/providers/adapters";
import type { ConversionPlanner, ConversionResources, ConversionStep, TenantConversion } from "@/lib/providers/adapters/types";
import { webhookUrl } from "@/lib/webhooks/url";
import { mergeSettings, adapterFor, type OrganizationProviderRow, type ProviderRow } from "./index";
import { tenantNameFor } from "./shared";

export type ConversionStage = "parent" | ConversionStep | "flip";

export const CONVERSION_STAGES: ConversionStage[] = ["parent", "parent_setup", "tenant", "associate", "tag", "suppression", "flip"];

/** Settings key holding the last finished stage among associate, tag and suppression. */
const PROGRESS_KEY = "conversionStep";
const RESUMABLE: ConversionStep[] = ["associate", "tag", "suppression"];

export interface PlannedStage {
  stage: ConversionStage;
  done: boolean;
  calls: string[];
}

export interface ConversionPlan {
  providerId: string;
  organizationId: string;
  tenantName: string;
  /** Null while the parent doesn't exist yet. */
  parentId: string | null;
  parentName: string;
  resources: ConversionResources;
  /** What the remaining stages need, as provider permissions. */
  permissions: string[];
  stages: PlannedStage[];
  converted: boolean;
}

export interface ConversionOptions {
  actor: ActivityActor;
  /** Plans and prints the provider calls without making any, or writing anything. */
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface ConversionResult {
  plan: ConversionPlan;
  /** The last stage that finished, or null when none did. */
  reached: ConversionStage | null;
  converted: boolean;
  suppressionsCopied: number;
}

/** A provider call failed part way. A rerun resumes at `stage`. */
export class ConversionStoppedError extends Error {
  constructor(
    readonly stage: ConversionStage,
    readonly reached: ConversionStage | null,
    cause: unknown,
  ) {
    super(`Conversion stopped at ${stage}: ${safeErrorMessage(cause)}`, { cause });
    this.name = "ConversionStoppedError";
  }
}

/** The credentials can't make calls the conversion needs. Nothing was changed. */
export class MissingPermissionsError extends ApiError {
  constructor(readonly missing: string[]) {
    super("validation_failed", `The provider credentials are missing permissions the conversion needs: ${missing.join(", ")}.`, {
      detail: { missing_permissions: missing },
    });
  }
}

async function rowById(id: string): Promise<ProviderRow | undefined> {
  const [row] = await db.select().from(providers).where(eq(providers.id, id)).limit(1);
  return row;
}

async function legacyRow(id: string): Promise<OrganizationProviderRow> {
  const row = await rowById(id);
  if (!row) throw new ApiError("not_found", `No provider with id ${id}.`);
  if (row.shared || row.organizationId === null) {
    throw new ApiError("validation_failed", `${row.name} is a shared provider and can't be converted.`);
  }
  if (!capabilitiesOf(row.adapter).sharing) {
    throw new ApiError("validation_failed", `Provider adapter "${row.adapter}" can't be shared, so ${row.name} has nothing to move onto.`);
  }
  return row as OrganizationProviderRow;
}

async function findParent(row: ProviderRow): Promise<ProviderRow | undefined> {
  if (row.sharedProviderId) return rowById(row.sharedProviderId);
  const [parent] = await db
    .select()
    .from(providers)
    .where(
      and(
        eq(providers.shared, true),
        eq(providers.adapter, row.adapter),
        eq(providers.providerIdentity, row.providerIdentity ?? ""),
      ),
    )
    .orderBy(providers.createdAt)
    .limit(1);
  return parent;
}

/** A free name among shared providers, starting from the row's own. */
async function parentNameFor(row: ProviderRow): Promise<string> {
  const [org] = row.organizationId
    ? await db.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, row.organizationId)).limit(1)
    : [];
  const taken = new Set(
    (await db.select({ name: providers.name }).from(providers).where(eq(providers.shared, true))).map((entry) => entry.name),
  );
  const base = taken.has(row.name) ? `${row.name} (${org?.slug ?? row.organizationId})` : row.name;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} (${n})`)) return `${base} (${n})`;
}

async function boundIdentities(row: ProviderRow): Promise<string[]> {
  const bound = await db
    .select({
      name: domains.name,
      providerDomainId: domains.providerDomainId,
      providerId: domains.providerId,
      pendingProviderDomainId: domains.pendingProviderDomainId,
    })
    .from(domains)
    .where(or(eq(domains.providerId, row.id), eq(domains.pendingProviderId, row.id)));
  const names = bound.map((domain) =>
    domain.providerId === row.id ? (domain.providerDomainId ?? domain.name) : (domain.pendingProviderDomainId ?? domain.name),
  );
  return [...new Set(names)].sort();
}

/** Refuses a row the flip would collide with. */
async function assertNoOtherTenant(row: OrganizationProviderRow, tenantName: string, parentId: string | null): Promise<void> {
  const [clash] = await db
    .select({ id: providers.id, name: providers.name })
    .from(providers)
    .where(
      and(
        eq(providers.organizationId, row.organizationId),
        ne(providers.id, row.id),
        or(
          parentId ? eq(providers.sharedProviderId, parentId) : undefined,
          and(
            sql`${providers.settings}->>'tenantName' = ${tenantName}`,
            eq(providers.providerIdentity, row.providerIdentity ?? ""),
          ),
        ),
      ),
    )
    .limit(1);
  if (clash) {
    throw new ApiError(
      "validation_failed",
      `The organization already has assignment row ${clash.name} (${clash.id}) on this provider. Move its domains here and unassign it first.`,
    );
  }
}

function plannerOf(adapter: string): ConversionPlanner {
  const planner = conversionPlanOf(adapter);
  if (!planner) throw new ApiError("validation_failed", `Provider adapter "${adapter}" can't move a provider onto a shared one.`);
  return planner;
}

function conversionOf(row: ProviderRow): TenantConversion {
  const conversion = adapterFor(row).conversion;
  if (!conversion) throw new ApiError("validation_failed", `Provider adapter "${row.adapter}" can't move a provider onto a shared one.`);
  return conversion;
}

/** Reads what a conversion of `providerId` would do. Makes no provider call and writes nothing. */
export async function planConversion(providerId: string): Promise<ConversionPlan> {
  const row = await legacyRow(providerId);
  const tenantName = row.settings.tenantName || tenantNameFor(row.organizationId);
  const resources = { configurationSetName: row.settings.configurationSetName ?? "", identities: await boundIdentities(row) };
  const conversion = plannerOf(row.adapter);
  const converted = Boolean(row.sharedProviderId);

  if (!converted) {
    if (!row.providerIdentity) {
      throw new ApiError("validation_failed", `${row.name} has no known provider identity yet. The health check fetches it within five minutes.`);
    }
    if (!resources.configurationSetName || !row.settings.topicArn) {
      throw new ApiError("validation_failed", `${row.name} hasn't finished its event setup, so there's no configuration set to move.`);
    }
  }

  const parent = await findParent(row);
  if (!converted) await assertNoOtherTenant(row, tenantName, parent?.id ?? null);
  const progress = RESUMABLE.indexOf(row.settings[PROGRESS_KEY] as ConversionStep);
  const done: Record<ConversionStage, boolean> = {
    parent: Boolean(parent),
    parent_setup: Boolean(parent?.settings.topicArn && parent.settings.eventRuleArn),
    tenant: Boolean(row.settings.tenantArn),
    associate: progress >= 0,
    tag: progress >= 1,
    suppression: progress >= 2,
    flip: converted,
  };
  if (converted) for (const stage of CONVERSION_STAGES) done[stage] = true;

  const stages = CONVERSION_STAGES.map((stage) => ({
    stage,
    done: done[stage],
    calls: stage === "parent" || stage === "flip" ? [] : conversion.calls(stage, tenantName, resources),
  }));
  const remaining = stages.filter((entry) => !entry.done && entry.stage !== "parent" && entry.stage !== "flip").map((entry) => entry.stage);

  return {
    providerId: row.id,
    organizationId: row.organizationId,
    tenantName,
    parentId: parent?.id ?? null,
    parentName: parent?.name ?? (await parentNameFor(row)),
    resources,
    permissions: converted ? [] : conversion.permissions(remaining as ConversionStep[]),
    stages,
    converted,
  };
}

/** Reuses the shared provider on the same provider, or creates it from the row's credentials. */
async function ensureParent(row: ProviderRow, name: string): Promise<ProviderRow> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`convert-parent:${row.adapter}:${row.providerIdentity}`}))`);
    const existing = await findParent(row);
    if (existing) return existing;
    const [parent] = await tx
      .insert(providers)
      .values({
        id: newId("provider"),
        adapter: row.adapter,
        name,
        credentials: sql`(select ${providers.credentials} from ${providers} where ${providers.id} = ${row.id})`,
        providerIdentity: row.providerIdentity,
        settings: { sharing: "operator" },
        concurrency: row.concurrency,
        shared: true,
      })
      .returning();
    if (!parent) throw new Error("The shared provider couldn't be stored.");
    return parent;
  });
}

async function setupParent(parent: ProviderRow): Promise<void> {
  const setup = adapterFor(parent).setup;
  if (!setup) return;
  const configured = await setup.configureEvents("", {
    webhookUrl: webhookUrl(parent.adapter, parent.id),
    save: (patch) => mergeSettings(parent.id, patch),
  });
  await mergeSettings(parent.id, configured.settings);
}

/** Moves the row under the parent. Sends claimed after this carry the tenant name. */
async function flip(row: OrganizationProviderRow, parent: ProviderRow, tenantName: string, tenantArn: string): Promise<boolean> {
  const patch = { tenantName, tenantArn, configurationSetAssociated: "true" };
  const updated = await db
    .update(providers)
    .set({
      sharedProviderId: parent.id,
      credentials: sql`(select "p"."credentials" from ${providers} "p" where "p"."id" = ${parent.id})`,
      settings: sql`(${providers.settings} - ${PROGRESS_KEY}) || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(providers.id, row.id), isNull(providers.sharedProviderId)))
    .returning({ id: providers.id });
  return updated.length > 0;
}

function printPlan(plan: ConversionPlan, log: (line: string) => void, preflightCalls: string[]): void {
  log(`provider ${plan.providerId} in organization ${plan.organizationId}`);
  log(`tenant ${plan.tenantName}, parent ${plan.parentId ?? `(new) "${plan.parentName}"`}`);
  log(`configuration set ${plan.resources.configurationSetName}; identities: ${plan.resources.identities.join(", ") || "none"}`);
  if (plan.converted) {
    log("already converted; nothing to do");
    return;
  }
  log(`permissions checked first: ${plan.permissions.join(", ")}`);
  for (const call of preflightCalls) log(`  ${call}`);
  for (const { stage, done, calls } of plan.stages) {
    log(`${stage}${done ? " (done, skipped)" : ""}`);
    if (done) continue;
    if (stage === "parent" && !plan.parentId) log(`  DB insert shared provider "${plan.parentName}"`);
    if (stage === "flip") log(`  DB update ${plan.providerId}: shared_provider_id, credentials, settings.tenantName=${plan.tenantName}`);
    for (const call of calls) log(`  ${call}`);
  }
}

/**
 * Converts a legacy row into an assignment row with the same id. Each stage is idempotent and records
 * its progress, so a rerun after a failure resumes where it stopped.
 */
export async function convertToTenant(providerId: string, options: ConversionOptions): Promise<ConversionResult> {
  const log = options.log ?? (() => {});
  const plan = await planConversion(providerId);
  const result: ConversionResult = { plan, reached: null, converted: plan.converted, suppressionsCopied: 0 };
  const row = await legacyRow(providerId);
  const conversion = conversionOf(row);

  if (options.dryRun) {
    printPlan(plan, log, conversion.calls("preflight", plan.tenantName, plan.resources));
    return result;
  }
  if (plan.converted) {
    log("already converted; nothing to do");
    return { ...result, reached: "flip" };
  }

  const existingParent = plan.parentId ? await rowById(plan.parentId) : undefined;
  const missing = await conversionOf(existingParent ?? row).missingPermissions(plan.permissions);
  if (missing.length > 0) throw new MissingPermissionsError(missing);
  log(`permissions ok: ${plan.permissions.join(", ")}`);

  const isDone = (stage: ConversionStage) => plan.stages.find((entry) => entry.stage === stage)?.done ?? false;
  let reached: ConversionStage | null = null;
  async function run<T>(stage: ConversionStage, work: () => Promise<T>): Promise<T> {
    try {
      const value = await work();
      reached = stage;
      log(`${stage}: done`);
      return value;
    } catch (err) {
      throw new ConversionStoppedError(stage, reached, err);
    }
  }

  const parent = await run("parent", () => ensureParent(row, plan.parentName));
  if (!isDone("parent_setup")) await run("parent_setup", () => setupParent(parent));
  else reached = "parent_setup";

  // Calls run with the parent's credentials, which the row holds after the flip.
  const tenantSide = conversionOf({ ...row, credentials: parent.credentials });
  const tenantArn = row.settings.tenantArn
    ? row.settings.tenantArn
    : await run("tenant", async () => {
        const arn = await tenantSide.ensureTenant(plan.tenantName);
        await mergeSettings(row.id, { tenantArn: arn });
        return arn;
      });

  const stagesAfterTenant: [ConversionStep, () => Promise<unknown>][] = [
    ["associate", () => tenantSide.associate(plan.tenantName, tenantArn, plan.resources)],
    ["tag", () => tenantSide.tagIdentities(plan.tenantName, tenantArn, plan.resources.identities)],
    [
      "suppression",
      async () => {
        result.suppressionsCopied = await tenantSide.copySuppressions(plan.tenantName);
        log(`suppression: copied ${result.suppressionsCopied} addresses`);
      },
    ],
  ];
  for (const [stage, work] of stagesAfterTenant) {
    if (isDone(stage)) {
      reached = stage;
      continue;
    }
    await run(stage, async () => {
      await work();
      await mergeSettings(row.id, { [PROGRESS_KEY]: stage });
    });
  }

  const flipped = await run("flip", () => flip(row, parent, plan.tenantName, tenantArn));
  if (flipped) {
    await recordActivity({
      organizationId: row.organizationId,
      action: "provider.shared.converted",
      actor: options.actor,
      appliesTo: row.id,
      subjectLabel: row.name,
      metadata: { sharedProviderId: parent.id, tenantName: plan.tenantName },
    });
  }
  return { ...result, plan: { ...plan, parentId: parent.id }, reached, converted: true };
}
