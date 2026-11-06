import { and, inArray, eq, sql } from "drizzle-orm";
import type { Executor } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { addressForwardTargets, addressForwards } from "@/lib/db/schema";
import type { ForwardDisabledReason } from "./constants";

export async function disableTargets(executor: Executor, targetIds: string[], reason: ForwardDisabledReason): Promise<void> {
  if (targetIds.length === 0) return;
  const now = await dbNow(executor);
  await executor
    .update(addressForwardTargets)
    .set({ status: "disabled", disabledAt: now, disabledReason: reason, tokenHash: null, tokenExpiresAt: null, updatedAt: now })
    .where(and(inArray(addressForwardTargets.id, targetIds), sql`${addressForwardTargets.status} <> 'disabled'`));
}

/** A forward that hard-bounced or drew a complaint disables its target. */
export async function disableTargetsForMessage(executor: Executor, messageId: string, status: string): Promise<void> {
  const reason: ForwardDisabledReason | null = status === "bounced" ? "bounced" : status === "complained" ? "complained" : null;
  if (!reason) return;
  const rows = await executor.select({ targetId: addressForwards.targetId }).from(addressForwards).where(eq(addressForwards.messageId, messageId));
  await disableTargets(executor, [...new Set(rows.map((row) => row.targetId))], reason);
}
