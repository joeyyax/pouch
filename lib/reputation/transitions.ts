/** Acts on standing changes: activity, webhooks, owner email and operator push, once per change. */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations, reputationStates, type ReputationStateRow, type ReputationSubject } from "@/lib/db/schema";
import { recordActivity, workerActor } from "@/lib/activity/record";
import { baseUrl } from "@/lib/api/urls";
import { newId } from "@/lib/ids";
import { logger } from "@/lib/logger";
import type { ReputationAlertKind } from "@/lib/mail/alerts/reputation-changed";
import { notifyDeliveryTime } from "@/lib/notifications/delivery-time";
import { sendNotification } from "@/lib/notifications/send";
import { sendReputationAtRiskAlert } from "@/lib/notifications/push/reputation-at-risk";
import { enqueueDomainScopedWebhookEvent, enqueueOrganizationWebhookEvent } from "@/lib/webhooks/dispatch";
import { readSetting } from "@/lib/settings/values";
import { readOrganizationReputation } from "./read";
import { worseStanding, type Standing, type StandingResult } from "./standing";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("reputation");

const HOUR_MS = 60 * 60 * 1000;

const ALERTING: ReadonlySet<Standing> = new Set(["at_risk", "paused"]);

/**
 * Whether a change emails owners. A worse standing than the last one emailed always does; the
 * same standing again only once `repeatHours` (`standing_alert_repeat_hours`) has passed. Leaving paused is a release.
 */
export function alertFor(
  state: Pick<ReputationStateRow, "alertedStanding" | "alertedAt"> | null,
  from: Standing,
  to: Standing,
  now: Date,
  repeatHours: number,
): ReputationAlertKind | null {
  if (from === "paused" && to !== "paused") return "released";
  if (!ALERTING.has(to)) return null;
  const recent = state?.alertedAt && now.getTime() - state.alertedAt.getTime() < repeatHours * HOUR_MS ? state.alertedStanding : null;
  return recent === null || worseStanding(to, recent) ? "entered" : null;
}

export interface Subject {
  type: ReputationSubject;
  id: string;
  organizationId: string;
  organizationName: string;
  name: string;
}

/** Claims the change from `from` to `to`. False when another worker already recorded it. */
async function claim(subject: Subject, existing: ReputationStateRow | undefined, to: Standing, now: Date): Promise<boolean> {
  if (!existing) {
    const inserted = await db
      .insert(reputationStates)
      .values({ organizationId: subject.organizationId, subjectType: subject.type, subjectId: subject.id, standing: to, changedAt: now })
      .onConflictDoNothing()
      .returning({ id: reputationStates.subjectId });
    return inserted.length > 0;
  }
  const updated = await db
    .update(reputationStates)
    .set({ standing: to, changedAt: now, updatedAt: now })
    .where(
      and(
        eq(reputationStates.subjectType, subject.type),
        eq(reputationStates.subjectId, subject.id),
        eq(reputationStates.standing, existing.standing),
      ),
    )
    .returning({ id: reputationStates.subjectId });
  return updated.length > 0;
}

function detailUrl(subject: Subject): string {
  return subject.type === "domain" ? `${baseUrl()}/domains/${subject.id}/reputation` : `${baseUrl()}/`;
}

/** Records one subject's standing and acts when it changed. Returns the change, or null. */
export async function syncStanding(
  subject: Subject,
  result: StandingResult,
  now: Date,
): Promise<{ from: Standing; to: Standing; alert: ReputationAlertKind | null } | null> {
  const [existing] = await db
    .select()
    .from(reputationStates)
    .where(and(eq(reputationStates.subjectType, subject.type), eq(reputationStates.subjectId, subject.id)))
    .limit(1);

  const from = existing?.standing ?? "healthy";
  const to = result.standing;
  if (from === to) return null;
  if (!(await claim(subject, existing, to, now))) return null;

  const findings = result.findings.map(({ kind, standing, title, body, action }) => ({ kind, standing, title, body, action }));
  await recordActivity({
    organizationId: subject.organizationId,
    action: subject.type === "domain" ? "domain.reputation.changed" : "organization.reputation.changed",
    actor: workerActor("Reputation"),
    appliesTo: subject.id,
    subjectLabel: subject.name,
    metadata: { from, to, findings: findings.map((finding) => finding.kind) },
  });

  const data = {
    object: "reputation",
    subject: { type: subject.type, id: subject.id, name: subject.name },
    standing: to,
    previous_standing: from,
    changed_at: now.toISOString(),
    findings,
  };
  const webhook =
    subject.type === "domain"
      ? enqueueDomainScopedWebhookEvent(subject.organizationId, {
          eventId: newId("event"),
          eventType: "domain.reputation_changed",
          occurredAt: now,
          domainId: subject.id,
          data,
        })
      : enqueueOrganizationWebhookEvent(subject.organizationId, {
          eventId: newId("event"),
          eventType: "organization.reputation_changed",
          occurredAt: now,
          data,
        });
  await webhook.catch((err: unknown) => log.warn(`couldn't enqueue the reputation webhook for ${subject.name}: ${safeErrorMessage(err)}`));

  const alert = alertFor(existing ?? null, from, to, now, await readSetting("standing_alert_repeat_hours"));
  if (alert) await emailOwners(subject, result, alert, to, now);

  if (to === "at_risk" && alert === "entered") {
    await sendReputationAtRiskAlert(subject.name, subject.organizationName, result.findings).catch((err: unknown) => {
      log.warn(`couldn't send the at-risk push for ${subject.name}: ${safeErrorMessage(err)}`);
    });
  }

  return { from, to, alert };
}

/** The notification type a change sends as. */
export function standingNotification(kind: ReputationAlertKind, to: Standing): "standing_at_risk" | "standing_paused" | "standing_resumed" {
  if (kind === "released") return "standing_resumed";
  return to === "paused" ? "standing_paused" : "standing_at_risk";
}

async function emailOwners(subject: Subject, result: StandingResult, kind: ReputationAlertKind, to: Standing, now: Date): Promise<void> {
  const { sent } = await sendNotification({
    type: standingNotification(kind, to),
    organizationId: subject.organizationId,
    input: {
      kind,
      subjectType: subject.type,
      subjectName: subject.name,
      standing: to,
      findings: result.findings,
      url: detailUrl(subject),
      changedAt: now,
    },
    key: `${subject.type}:${subject.id}:${kind}:${to}:${now.toISOString()}`,
    appliesTo: subject.id,
  });
  if (sent === 0) return;

  await db
    .update(reputationStates)
    .set({ alertedStanding: kind === "released" && !ALERTING.has(to) ? null : to, alertedAt: now })
    .where(and(eq(reputationStates.subjectType, subject.type), eq(reputationStates.subjectId, subject.id)));
}

/** Syncs every domain in the organization and the organization itself. */
export async function checkReputation(organizationId: string, now: Date): Promise<number> {
  const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  if (!org) return 0;
  const reputation = await readOrganizationReputation(organizationId, now);

  let changed = 0;
  for (const domain of reputation.domains.values()) {
    const subject = { type: "domain" as const, id: domain.id, organizationId, organizationName: org.name, name: domain.name };
    if (await syncStanding(subject, domain, now)) changed += 1;
  }
  const subject = { type: "organization" as const, id: organizationId, organizationId, organizationName: org.name, name: org.name };
  if (await syncStanding(subject, { standing: reputation.ownStanding, findings: reputation.findings }, now)) changed += 1;
  await notifyDeliveryTime(organizationId, reputation.domains.values(), now).catch((err: unknown) => {
    log.warn(`couldn't send delivery time notices for organization ${organizationId}: ${safeErrorMessage(err)}`);
  });
  return changed;
}
