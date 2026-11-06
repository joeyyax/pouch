"use server";

import { revalidatePath } from "next/cache";
import { adminActor } from "@/lib/activity/record";
import { requireAdmin } from "@/lib/auth/admin";
import { failed, succeeded, type ActionState } from "@/lib/dashboard/action-state";
import { removeServiceSuppression } from "@/lib/system/service-mail";

export async function removeServiceSuppressionAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireAdmin();
  const address = String(form.get("address") ?? "");

  try {
    const removed = await removeServiceSuppression(address, adminActor(session.user.id, session.user.name ?? session.user.email ?? "Admin"));
    revalidatePath("/admin/settings/system/mail");
    return succeeded(`System mail can reach ${removed} again.`);
  } catch (error) {
    return failed(error, "The suppression couldn't be removed.");
  }
}
