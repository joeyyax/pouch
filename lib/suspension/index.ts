/** Suspends, reads and releases an organization's ability to send. */
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { messages, organizations, type SuspensionSource } from "@/lib/db/schema";
import { recordActivity } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import { sendOrganizationSuspendedAlert } from "@/lib/notifications/push/organization-suspended";
import { holdsQueue } from "./sources";
import { safeErrorMessage } from "@/lib/errors/scrub";

export { SUSPENSION_SOURCES, type SuspensionSource } from "@/lib/db/schema";
export { HOLDING_SOURCES, holdsQueue } from "./sources";

const log = logger.child("suspension");

export interface SuspensionInput {
  source: SuspensionSource;
  /** One sentence, shown to the operator, the organization and API callers. */
  reason: string;
  detail?: Record<string, unknown> | null;
}

export interface OrganizationSuspension {
  suspendedAt: Date;
  source: SuspensionSource;
  reason: string;
  detail: Record<string, unknown> | null;
}

/** The sentence a failed message records. */
export function suspendedFailureReason(suspension: Pick<OrganizationSuspension, "reason">): string {
  return `Organization is suspended: ${suspension.reason}`;
}

type SuspensionColumns = Pick<
  typeof organizations.$inferSelect,
  "suspendedAt" | "suspendReason" | "suspendSource" | "suspendDetail"
>;

function toSuspension(row: SuspensionColumns | undefined): OrganizationSuspension | null {
  if (!row?.suspendedAt || !row.suspendSource) return null;
  return {
    suspendedAt: row.suspendedAt,
    source: row.suspendSource,
    reason: row.suspendReason ?? "",
    detail: row.suspendDetail ?? null,
  };
}

const suspensionColumns = {
  suspendedAt: organizations.suspendedAt,
  suspendReason: organizations.suspendReason,
  suspendSource: organizations.suspendSource,
  suspendDetail: organizations.suspendDetail,
};

export async function suspensionOf(organizationId: string): Promise<OrganizationSuspension | null> {
  const [row] = await db.select(suspensionColumns).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  return toSuspension(row);
}

export function suspendedError(suspension: OrganizationSuspension): ApiError {
  return new ApiError("organization_suspended", `This organization is suspended and can't send: ${suspension.reason}`, {
    detail: {
      source: suspension.source,
      reason: suspension.reason,
      suspended_at: suspension.suspendedAt.toISOString(),
    },
  });
}

/** Throws `organization_suspended` when the organization can't send. */
export async function assertNotSuspended(organizationId: string): Promise<void> {
  const suspension = await suspensionOf(organizationId);
  if (suspension) throw suspendedError(suspension);
}

/** Returns whether this call wrote the suspension; an existing one is kept as is. */
export async function suspendOrganization(
  organizationId: string,
  input: SuspensionInput,
  actor: ActivityActor,
  now?: Date,
): Promise<boolean> {
  const [org] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!org) throw new ApiError("not_found", `No organization with id ${organizationId}.`);

  const at = now ?? (await dbNow());
  const updated = await db
    .update(organizations)
    .set({
      suspendedAt: at,
      suspendReason: input.reason,
      suspendSource: input.source,
      suspendDetail: input.detail ?? null,
      updatedAt: at,
    })
    .where(and(eq(organizations.id, organizationId), isNull(organizations.suspendedAt)))
    .returning({ id: organizations.id });
  if (updated.length === 0) return false;

  log.warn(`suspended ${org.name} (${input.source}): ${input.reason}`);

  // Due now, so the worker reaches every queued message promptly instead of at its next retry.
  if (!holdsQueue(input.source)) {
    await db
      .update(messages)
      .set({ nextAttemptAt: at })
      .where(and(eq(messages.organizationId, organizationId), eq(messages.status, "queued")));
  }

  await recordActivity({
    organizationId,
    action: "organization.suspended",
    actor,
    appliesTo: organizationId,
    subjectLabel: org.name,
    metadata: { source: input.source, reason: input.reason, ...(input.detail ? { verdict: input.detail } : {}) },
  });

  await sendOrganizationSuspendedAlert(org.name, input).catch((err) => {
    log.warn(`couldn't send the suspended push alert for ${org.name}: ${safeErrorMessage(err)}`);
  });

  return true;
}

/** Clears a suspension. A person decides, except that the provider lifts its own. */
export async function releaseOrganizationSuspension(
  organizationId: string,
  actor: ActivityActor,
  now?: Date,
  options: { onlySource?: SuspensionSource } = {},
): Promise<boolean> {
  const at = now ?? (await dbNow());
  const [previous] = await db.select(suspensionColumns).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  if (!previous) throw new ApiError("not_found", `No organization with id ${organizationId}.`);
  const suspension = toSuspension(previous);
  if (!suspension) return false;
  if (options.onlySource && suspension.source !== options.onlySource) return false;

  const updated = await db
    .update(organizations)
    .set({ suspendedAt: null, suspendReason: null, suspendSource: null, suspendDetail: null, updatedAt: at })
    .where(
      and(
        eq(organizations.id, organizationId),
        isNotNull(organizations.suspendedAt),
        options.onlySource ? eq(organizations.suspendSource, options.onlySource) : undefined,
      ),
    )
    .returning({ name: organizations.name });
  const row = updated[0];
  if (!row) return false;

  await recordActivity({
    organizationId,
    action: "organization.suspension.released",
    actor,
    appliesTo: organizationId,
    subjectLabel: row.name,
    metadata: { source: suspension.source },
  });
  return true;
}
