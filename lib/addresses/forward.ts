import { and, eq, inArray } from "drizzle-orm";
import type { Executor } from "@/lib/db";
import { addressForwardTargets, addressForwards, type AddressRow, type InboundMessageRow } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import type { InboundVerdicts } from "@/lib/providers/adapters/types";
import { flagsFor } from "./route";

/** A virus never forwards, and neither do spam or DMARC failures: a mailbox owner didn't ask for either. */
export function mayForward(verdicts: InboundVerdicts | null): boolean {
  return verdicts?.virus !== "fail" && flagsFor(verdicts).length === 0;
}

/** Queues one forward per confirmed target of each address that admitted the message, in the storing transaction. */
export async function enqueueForwards(tx: Executor, message: InboundMessageRow, delivered: AddressRow[]): Promise<number> {
  if (delivered.length === 0 || !mayForward(message.verdicts)) return 0;
  const targets = await tx
    .select({ id: addressForwardTargets.id, addressId: addressForwardTargets.addressId })
    .from(addressForwardTargets)
    .where(
      and(
        eq(addressForwardTargets.organizationId, message.organizationId),
        inArray(addressForwardTargets.addressId, delivered.map((row) => row.id)),
        eq(addressForwardTargets.status, "confirmed"),
      ),
    );
  if (targets.length === 0) return 0;
  await tx.insert(addressForwards).values(
    targets.map((target) => ({
      id: newId("forward"),
      organizationId: message.organizationId,
      addressId: target.addressId,
      targetId: target.id,
      inboundMessageId: message.id,
    })),
  );
  return targets.length;
}
