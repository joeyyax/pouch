/** Provider reputation findings, kept open until the provider closes them. */
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { providerFindings } from "@/lib/db/schema";
import type { ProviderFinding } from "./standing";

export interface ProviderFindingEvent {
  organizationId: string;
  providerId: string;
  kind: "finding_opened" | "finding_closed";
  type: string | null;
  impact: string | null;
  description: string | null;
  /** When the provider opened it. Defaults to now. */
  openedAt?: Date | null;
}

/** Records a finding. True when it opened or closed; false for a repeat. */
export async function recordProviderFinding(event: ProviderFindingEvent): Promise<boolean> {
  const type = event.type ?? "UNKNOWN";
  const now = await dbNow();
  const row = and(eq(providerFindings.providerId, event.providerId), eq(providerFindings.type, type));
  if (event.kind === "finding_closed") {
    const closed = await db
      .update(providerFindings)
      .set({ closedAt: now })
      .where(and(row, isNull(providerFindings.closedAt)))
      .returning({ type: providerFindings.type });
    return closed.length > 0;
  }
  const details = { impact: event.impact, description: event.description };
  const opened = { ...details, openedAt: event.openedAt ?? now, closedAt: null };
  const inserted = await db
    .insert(providerFindings)
    .values({ organizationId: event.organizationId, providerId: event.providerId, type, ...opened })
    .onConflictDoNothing()
    .returning({ type: providerFindings.type });
  if (inserted.length > 0) return true;
  const reopened = await db
    .update(providerFindings)
    .set(opened)
    .where(and(row, isNotNull(providerFindings.closedAt)))
    .returning({ type: providerFindings.type });
  if (reopened.length > 0) return true;
  await db.update(providerFindings).set(details).where(row);
  return false;
}

export interface OpenFindingRow {
  providerId: string;
  organizationId: string;
  type: string;
}

/** Open findings on any of these assignment rows. */
export async function openFindingsFor(providerIds: string[]): Promise<OpenFindingRow[]> {
  if (providerIds.length === 0) return [];
  return db
    .select({ providerId: providerFindings.providerId, organizationId: providerFindings.organizationId, type: providerFindings.type })
    .from(providerFindings)
    .where(and(inArray(providerFindings.providerId, providerIds), isNull(providerFindings.closedAt)));
}

export interface OpenProviderFinding extends ProviderFinding {
  openedAt: Date;
}

/** One assignment row's open findings, newest first, for the reputation detail. */
export async function openFindingsOnProvider(providerId: string): Promise<OpenProviderFinding[]> {
  const rows = await db
    .select({
      type: providerFindings.type,
      impact: providerFindings.impact,
      description: providerFindings.description,
      openedAt: providerFindings.openedAt,
    })
    .from(providerFindings)
    .where(and(eq(providerFindings.providerId, providerId), isNull(providerFindings.closedAt)));
  return rows.sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime());
}

export async function openProviderFindings(organizationId: string): Promise<(ProviderFinding & { providerId: string })[]> {
  return db
    .select({ providerId: providerFindings.providerId, type: providerFindings.type, impact: providerFindings.impact, description: providerFindings.description })
    .from(providerFindings)
    .where(and(eq(providerFindings.organizationId, organizationId), isNull(providerFindings.closedAt)));
}
