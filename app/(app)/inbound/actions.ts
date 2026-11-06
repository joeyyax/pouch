"use server";

import { revalidatePath } from "next/cache";
import { requireOrganizationWrite } from "@/lib/dashboard/session";
import { redeliverInbound } from "@/lib/inbound/redeliver";
import { failed, succeeded, type ActionState } from "@/lib/dashboard/action-state";
import { featureAction } from "@/lib/dashboard/feature-action";

export const redeliverInboundAction = featureAction("inbound", async function redeliverInboundAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const { organizationId } = await requireOrganizationWrite("redeliver this message");
  const id = String(form.get("id") ?? "");

  try {
    const delivered = await redeliverInbound(organizationId, id);
    if (!delivered) return failed(new Error("no endpoint"), "This domain has no webhook to redeliver to.");
    revalidatePath(`/inbound/${id}`);
    return succeeded("Redelivery queued.");
  } catch (error) {
    return failed(error, "Redelivering this message failed.");
  }
});
