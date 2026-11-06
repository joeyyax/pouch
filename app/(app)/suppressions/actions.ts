"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrganizationWrite, sessionActor } from "@/lib/dashboard/session";
import { addSuppression, removeSuppression } from "@/lib/messages/suppression-manage";
import { failed, succeeded, type ActionState } from "@/lib/dashboard/action-state";

export async function addSuppressionAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireOrganizationWrite("suppress an address");
  const note = String(form.get("note") ?? "") || null;

  try {
    const address = await addSuppression(
      session.organizationId,
      String(form.get("address") ?? ""),
      note,
      sessionActor(session),
    );
    revalidatePath("/suppressions");
    return succeeded(`Sends to ${address} now fail.`);
  } catch (error) {
    return failed(error, "The address couldn't be suppressed.");
  }
}

export async function removeSuppressionAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireOrganizationWrite(
    "remove a suppression",
    "A suppressed address bounced or complained, and sending to it again risks the domain's reputation.",
  );

  try {
    const address = await removeSuppression(
      session.organizationId,
      String(form.get("address") ?? ""),
      sessionActor(session),
    );
    revalidatePath("/suppressions");
    return succeeded(`Sends to ${address} go out again.`);
  } catch (error) {
    return failed(error, "The address couldn't be removed.");
  }
}

/** Removes from the detail screen, then leaves it: the page 404s once its row is gone. */
export async function removeSuppressionAndLeaveAction(previous: ActionState, form: FormData): Promise<ActionState> {
  const state = await removeSuppressionAction(previous, form);
  if (state.status !== "ok") return state;
  redirect("/suppressions");
}
