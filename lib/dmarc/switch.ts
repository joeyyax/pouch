/** DMARC reports: the install's `dmarc_reports` feature, then an organization's own switch, `organizations.dmarc_reports_enabled`, on by default. */
import { and, eq, inArray } from "drizzle-orm";
import { isFeatureEnabled } from "@/lib/features";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { organizations } from "@/lib/db/schema";
import { recordActivity } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";

/** Organizations among `organizationIds` without DMARC reports: all of them while the feature is off, else those that turned them off. */
export async function dmarcOffFor(organizationIds: string[]): Promise<Set<string>> {
  if (organizationIds.length === 0) return new Set();
  if (!(await isFeatureEnabled("dmarc_reports"))) return new Set(organizationIds);
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(inArray(organizations.id, organizationIds), eq(organizations.dmarcReportsEnabled, false)));
  return new Set(rows.map((row) => row.id));
}

export async function dmarcOnFor(organizationId: string): Promise<boolean> {
  return !(await dmarcOffFor([organizationId])).has(organizationId);
}

export interface DmarcSwitchCaller {
  organizationId: string;
  actor: ActivityActor;
}

/** Turns DMARC reports on or off for the organization. Setting it to what it is changes nothing. */
export async function setDmarcReportsEnabled(caller: DmarcSwitchCaller, enabled: boolean): Promise<void> {
  const changed = await db
    .update(organizations)
    .set({ dmarcReportsEnabled: enabled, updatedAt: await dbNow() })
    .where(and(eq(organizations.id, caller.organizationId), eq(organizations.dmarcReportsEnabled, !enabled)))
    .returning({ id: organizations.id });
  if (changed.length === 0) return;
  await recordActivity({
    organizationId: caller.organizationId,
    action: enabled ? "settings.dmarc_reports.turned_on" : "settings.dmarc_reports.turned_off",
    actor: caller.actor,
  });
}
