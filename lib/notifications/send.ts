/** Owner email through the notification registry: operator switch, each owner's choice, then the throttle. */
import { and, eq } from "drizzle-orm";
import { createElement } from "react";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { memberships, notificationPreferences, users } from "@/lib/db/schema";
import { recordActivity, workerActor } from "@/lib/activity/record";
import { baseUrl } from "@/lib/api/urls";
import { ROLES } from "@/lib/auth/permissions";
import { sha256 } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { sendSystemMail } from "@/lib/mail/system";
import { SystemMail } from "@/lib/mail/template";
import { readSetting } from "@/lib/settings/values";
import { NOTIFICATIONS, notificationSetting, type NotificationDef, type NotificationInput, type NotificationType } from "./registry";
import { claimNotification, releaseNotification, type Claim } from "./throttle";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("notifications");

/** Where every notification's footer link goes. */
export const NOTIFICATION_SETTINGS_PATH = "/user/settings#notifications";

export interface Notification<T extends NotificationType> {
  type: T;
  organizationId: string;
  input: NotificationInput<T>;
  /** Identifies this one notice. Each owner's copy is idempotent on it. */
  key: string;
  /** What it's about. An `until_clear` type sends while any of these is new. */
  about?: string[];
  /** The activity row's subject id. Defaults to the first of `about`. */
  appliesTo?: string;
  /** The throttle's clock, from `dbNow()`. */
  now?: Date;
}

export interface NotificationResult {
  sent: number;
  failed: number;
  /** Why nothing went out when nothing was tried. */
  skipped: "operator" | "preferences" | "throttled" | null;
}

/** Owners of the organization and whether each wants this type. */
async function ownersFor(organizationId: string, type: NotificationType): Promise<{ id: string; email: string; wants: boolean }[]> {
  const rows = await db
    .select({ id: users.id, email: users.email, preference: notificationPreferences.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(notificationPreferences, and(eq(notificationPreferences.userId, users.id), eq(notificationPreferences.type, type)))
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.role, ROLES.OWNER)));
  return rows.map((row) => ({ id: row.id, email: row.email, wants: row.preference ?? NOTIFICATIONS[type].default }));
}

/** Emails the organization's owners who want this type. The organization's own mutes are the caller's to apply first. */
export async function sendNotification<T extends NotificationType>(notification: Notification<T>): Promise<NotificationResult> {
  const { type, organizationId, input, key } = notification;
  const def = NOTIFICATIONS[type] as unknown as NotificationDef<NotificationInput<T>>;
  if (!(await readSetting(notificationSetting(type)))) return { sent: 0, failed: 0, skipped: "operator" };

  const owners = await ownersFor(organizationId, type);
  const recipients = owners.filter((owner) => owner.wants);
  if (recipients.length === 0) return { sent: 0, failed: 0, skipped: owners.length > 0 ? "preferences" : null };

  const about = notification.about ?? [];
  let claims: Claim[] = [];
  if (def.throttle.kind === "until_clear") {
    claims = await claimNotification(organizationId, type, about, def.throttle.minHours, notification.now ?? (await dbNow()));
    if (claims.length === 0) return { sent: 0, failed: 0, skipped: "throttled" };
  }

  const subject = def.subject(input);
  const email = createElement(SystemMail, { ...def.mail(input), footerLink: { label: "Notification settings", url: `${baseUrl()}${NOTIFICATION_SETTINGS_PATH}` } });
  let sent = 0;
  for (const owner of recipients) {
    try {
      await sendSystemMail({ to: owner.email, subject, email, tags: [def.tag ?? type], idempotencyKey: `${type}:${key}:${owner.id}` });
      sent += 1;
    } catch (err) {
      log.warn(`couldn't send ${type} to an owner of ${organizationId}: ${safeErrorMessage(err)}`);
    }
  }

  if (sent === 0) {
    await releaseNotification(organizationId, type, claims);
    return { sent, failed: recipients.length, skipped: null };
  }

  await recordActivity({
    organizationId,
    action: "notification.emailed",
    actor: workerActor("Notifications"),
    appliesTo: notification.appliesTo ?? about[0] ?? type,
    subjectLabel: subject,
    metadata: { type, owners: sent, silenced: owners.length - recipients.length },
  });
  return { sent, failed: recipients.length - sent, skipped: null };
}

/** A short, stable idempotency key for a set of subjects. */
export function aboutKey(about: string[], now: Date): string {
  return `${now.toISOString()}:${sha256([...about].sort().join("\n")).slice(0, 16)}`;
}
