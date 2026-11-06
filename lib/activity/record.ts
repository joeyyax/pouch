/**
 * Activity log — write side. Server-only.
 *
 * WRITES ARE NON-FATAL. If the insert fails, log and continue. Revoking a key must never
 * fail because Postgres flapped on the history insert — losing one row is always cheaper
 * than failing the mutation that caused it.
 *
 * The actor is explicit: a session user, an API key, the worker or a provider callback.
 * `system` is a first-class value here (actor type "worker"), never a null user id.
 */
import { db } from "@/lib/db";
import { activity } from "@/lib/db/schema/activity";
import { newId } from "@/lib/ids";
import { logger } from "@/lib/logger";
import { brand } from "@/lib/brand";
import { clientPolicyFor, familyFor, isActivityAction, outcomeFor, type ActivityAction } from "./taxonomy";
import type { ActivityActor } from "./types";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("activity");

export function userActor(id: string, label: string): ActivityActor {
  return { type: "user", id, label };
}

/**
 * A service admin acting on the service's authority — inside an organization they're
 * emulating, or on it from the admin screens. Never a member's write.
 */
export function adminActor(id: string, label: string): ActivityActor {
  return { type: "admin", id, label };
}

export function apiKeyActor(id: string, label: string): ActivityActor {
  return { type: "api_key", id, label };
}

/** The worker and any other unattended process. `label` says which one. */
export function workerActor(label: string = brand.name): ActivityActor {
  return { type: "worker", id: null, label };
}

export function providerActor(id: string | null, label: string): ActivityActor {
  return { type: "provider", id, label };
}

export interface RecordActivityOptions {
  /** Null for a service-level write, which belongs to no organization. */
  organizationId: string | null;
  action: ActivityAction;
  actor: ActivityActor;
  /** The subject's id. Omit for an organization-wide action. */
  appliesTo?: string | null;
  /** The subject's current name, snapshotted so the row outlives it. */
  subjectLabel?: string | null;
  metadata?: Record<string, unknown>;
  /** The requester's hashed address (`clientOf`) and user agent. Kept only where the action's taxonomy entry allows it. */
  client?: { ipHash?: string | null; userAgent?: string | null };
}

const USER_AGENT_MAX = 255;

export async function recordActivity(options: RecordActivityOptions): Promise<void> {
  if (!isActivityAction(options.action)) {
    // Not reachable through the exported ActivityAction type, but a defensive check
    // costs nothing and keeps a bad string from writing a row nothing can classify.
    log.warn(`unknown action "${options.action}", skipping`);
    return;
  }

  const policy = clientPolicyFor(options.action);
  const ipHash = policy.ipHash ? options.client?.ipHash || null : null;
  const userAgent = policy.userAgent ? options.client?.userAgent?.slice(0, USER_AGENT_MAX) || null : null;

  try {
    await db.insert(activity).values({
      id: newId("activity"),
      organizationId: options.organizationId,
      action: options.action,
      family: familyFor(options.action),
      outcome: outcomeFor(options.action),
      actorType: options.actor.type,
      actorId: options.actor.id,
      actorLabel: options.actor.label,
      appliesTo: options.appliesTo ?? null,
      subjectLabel: options.subjectLabel ?? null,
      ipHash,
      userAgent,
      metadata: options.metadata ?? null,
    });
  } catch (error) {
    log.warn(`record failed action=${options.action}: ${safeErrorMessage(error)}`);
  }
}
