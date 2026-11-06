/**
 * Who gets which digest. Digests are the operator's cross-organization view (`lib/mail/digest/metrics.ts`),
 * so the audience is every operator, not every user — an organization admin has nothing to do
 * with a number that spans organizations they can't see.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { digestPreferences, users } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import type { DigestCadence } from "./cadence";

export interface DigestRecipient {
  userId: string;
  email: string;
}

const DEFAULT_ENABLED: Record<DigestCadence, boolean> = { daily: false, weekly: true, monthly: false };

/** Every operator opted into `cadence`, missing preference rows read as the defaults above. */
export async function listDigestRecipients(cadence: DigestCadence): Promise<DigestRecipient[]> {
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      preference: digestPreferences[cadence],
    })
    .from(users)
    .leftJoin(digestPreferences, eq(digestPreferences.userId, users.id))
    .where(eq(users.admin, true));

  return rows
    .filter((row) => row.preference ?? DEFAULT_ENABLED[cadence])
    .map((row) => ({ userId: row.userId, email: row.email }));
}

export interface DigestPreferencesView {
  daily: boolean;
  weekly: boolean;
  monthly: boolean;
}

export async function readDigestPreferences(userId: string): Promise<DigestPreferencesView> {
  const [row] = await db
    .select({ daily: digestPreferences.daily, weekly: digestPreferences.weekly, monthly: digestPreferences.monthly })
    .from(digestPreferences)
    .where(eq(digestPreferences.userId, userId))
    .limit(1);
  return row ?? { daily: DEFAULT_ENABLED.daily, weekly: DEFAULT_ENABLED.weekly, monthly: DEFAULT_ENABLED.monthly };
}

/** Upserts the three cadences at once — the settings form always submits all of them together. */
export async function updateDigestPreferences(userId: string, patch: DigestPreferencesView): Promise<void> {
  const existing = await db
    .select({ id: digestPreferences.id })
    .from(digestPreferences)
    .where(eq(digestPreferences.userId, userId))
    .limit(1);

  if (existing[0]) {
    await db.update(digestPreferences).set({ ...patch, updatedAt: new Date() }).where(eq(digestPreferences.userId, userId));
  } else {
    await db.insert(digestPreferences).values({ id: newId("digestPreferences"), userId, ...patch });
  }
}
