/** Emails owners about observations, after the organization's mutes have dropped what they cover. */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { runObservations } from "@/lib/observations/_runner";
import type { NotificationType } from "./registry";
import { aboutKey, sendNotification } from "./send";
import { clearNotifications } from "./throttle";

/** The observations that are notification types. */
export const OBSERVATION_NOTIFICATIONS = ["account_targeted", "tag_quiet", "domain_spoofed"] as const satisfies readonly NotificationType[];

/** One pass for the organization: sends what's new and clears what stopped holding. Returns how many mails went out. */
export async function notifyObservations(organizationId: string, now: Date): Promise<number> {
  const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  if (!org) return 0;

  const results = await runObservations(organizationId, now);
  let emailed = 0;
  for (const type of OBSERVATION_NOTIFICATIONS) {
    const holding: string[] = [];
    for (const result of results) {
      if (result.key !== type || !result.notice) continue;
      holding.push(...result.notice.about);
      const { sent } = await sendNotification({
        type,
        organizationId,
        input: { organizationName: org.name, wording: result.notice.wording },
        key: aboutKey(result.notice.about, now),
        about: result.notice.about,
        appliesTo: type,
        now,
      });
      if (sent > 0) emailed += 1;
    }
    await clearNotifications(organizationId, type, holding, now);
  }
  return emailed;
}
