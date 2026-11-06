/** The `until_clear` throttle: one row per organization, type and subject in `notification_sends`. */
import { and, eq, isNotNull, isNull, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { notificationSends, type NotificationSendRow } from "@/lib/db/schema";

const HOUR_MS = 60 * 60 * 1000;

export interface Claim {
  about: string;
  /** The row before the claim, null when there was none. */
  previous: Pick<NotificationSendRow, "sentAt" | "clearedAt"> | null;
}

function key(organizationId: string, type: string, about: string) {
  return and(eq(notificationSends.organizationId, organizationId), eq(notificationSends.type, type), eq(notificationSends.about, about));
}

/**
 * Claims each subject that's due: never sent, or cleared since its last send and at least
 * `minHours` past it. Returns the claims made; a concurrent claim on the same row loses.
 */
export async function claimNotification(organizationId: string, type: string, about: string[], minHours: number, now: Date): Promise<Claim[]> {
  const claims: Claim[] = [];
  for (const subject of new Set(about)) {
    const [existing] = await db
      .select({ sentAt: notificationSends.sentAt, clearedAt: notificationSends.clearedAt })
      .from(notificationSends)
      .where(key(organizationId, type, subject))
      .limit(1);

    if (!existing) {
      const inserted = await db
        .insert(notificationSends)
        .values({ organizationId, type, about: subject, sentAt: now })
        .onConflictDoNothing()
        .returning({ about: notificationSends.about });
      if (inserted.length > 0) claims.push({ about: subject, previous: null });
      continue;
    }

    if (existing.clearedAt === null || now.getTime() - existing.sentAt.getTime() < minHours * HOUR_MS) continue;
    const updated = await db
      .update(notificationSends)
      .set({ sentAt: now, clearedAt: null })
      .where(and(key(organizationId, type, subject), eq(notificationSends.sentAt, existing.sentAt), isNotNull(notificationSends.clearedAt)))
      .returning({ about: notificationSends.about });
    if (updated.length > 0) claims.push({ about: subject, previous: existing });
  }
  return claims;
}

/** Puts claimed rows back after a send that reached nobody. */
export async function releaseNotification(organizationId: string, type: string, claims: Claim[]): Promise<void> {
  for (const claim of claims) {
    if (claim.previous === null) await db.delete(notificationSends).where(key(organizationId, type, claim.about));
    else await db.update(notificationSends).set(claim.previous).where(key(organizationId, type, claim.about));
  }
}

/** Marks every subject of the type that no longer holds as cleared, so it can send again. */
export async function clearNotifications(organizationId: string, type: string, holding: string[], now: Date): Promise<void> {
  await db
    .update(notificationSends)
    .set({ clearedAt: now })
    .where(
      and(
        eq(notificationSends.organizationId, organizationId),
        eq(notificationSends.type, type),
        isNull(notificationSends.clearedAt),
        holding.length > 0 ? notInArray(notificationSends.about, holding) : undefined,
      ),
    );
}
