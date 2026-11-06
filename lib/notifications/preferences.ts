/** Each person's choice per notification type, across every organization they own. */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { memberships, notificationPreferences } from "@/lib/db/schema";
import { ApiError } from "@/lib/api/errors";
import { ROLES } from "@/lib/auth/permissions";
import { readSettingValues } from "@/lib/settings/values";
import { isNotificationType, NOTIFICATION_TYPES, NOTIFICATIONS, notificationLabel, notificationSetting } from "./registry";

export interface NotificationPreferenceView {
  type: string;
  label: string;
  description: string;
  /** This person's choice, or the type's default. */
  on: boolean;
  /** False when the operator turned the type off for the install. */
  available: boolean;
}

/** Every type, in registry order, with this person's choice. */
export async function readNotificationPreferences(userId: string): Promise<NotificationPreferenceView[]> {
  const [rows, settings] = await Promise.all([
    db.select({ type: notificationPreferences.type, email: notificationPreferences.email }).from(notificationPreferences).where(eq(notificationPreferences.userId, userId)),
    readSettingValues(),
  ]);
  const chosen = new Map(rows.map((row) => [row.type, row.email]));
  return NOTIFICATION_TYPES.map((type) => ({
    type,
    ...notificationLabel(type),
    on: chosen.get(type) ?? NOTIFICATIONS[type].default,
    available: settings[notificationSetting(type)] === true,
  }));
}

/** Sets one type on or off for this person. Back at the default, the row goes. */
export async function setNotificationPreference(userId: string, type: string, on: boolean): Promise<void> {
  if (!isNotificationType(type)) throw new ApiError("validation_failed", `No notification named ${type}.`, { field: "type" });
  const own = and(eq(notificationPreferences.userId, userId), eq(notificationPreferences.type, type));
  if (on === NOTIFICATIONS[type].default) {
    await db.delete(notificationPreferences).where(own);
    return;
  }
  await db
    .insert(notificationPreferences)
    .values({ userId, type, email: on })
    .onConflictDoUpdate({ target: [notificationPreferences.userId, notificationPreferences.type], set: { email: on, updatedAt: new Date() } });
}

/** Whether this person owns any organization, so there's mail for them to choose. */
export async function ownsAnOrganization(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.role, ROLES.OWNER)))
    .limit(1);
  return row !== undefined;
}
