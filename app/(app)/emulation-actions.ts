"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth/admin";
import { failed, type ActionState } from "@/lib/dashboard/action-state";
import { leaveEmulation } from "@/lib/dashboard/emulation";

/** Leaves the organization being emulated. Reachable from the banner on every screen. */
export async function stopEmulationAction(_previous: ActionState, _form: FormData): Promise<ActionState> {
  const session = await requireAdmin();

  try {
    await leaveEmulation({ id: session.user.id, label: session.user.name ?? session.user.email ?? "Admin" });
    revalidatePath("/", "layout");
  } catch (error) {
    return failed(error, "Emulation couldn't be ended.");
  }
  // Server-side, so leaving lands on the admin screen whether or not the banner is still mounted.
  redirect("/admin/settings/organizations");
}
