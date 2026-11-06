"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth/session";
import { leaveEmulation } from "@/lib/dashboard/emulation";
import { listReachableOrganizations, setActiveOrganization } from "@/lib/dashboard/session";

/**
 * Persists the acting organization choice. Refuses silently — no cookie set — when the chosen
 * id isn't one `listReachableOrganizations` returns for this user; the caller has nothing
 * useful to do with that beyond staying put, and `resolveDashboardSession` would refuse it too
 * if a stale or tampered cookie ever got through some other path.
 */
export async function switchOrganizationAction(organizationId: string): Promise<{ ok: boolean }> {
  const session = await getSession();
  if (!session?.user?.id) return { ok: false };

  const reachable = await listReachableOrganizations(session.user.id);
  if (!reachable.some((org) => org.id === organizationId)) return { ok: false };

  // Switching into your own organization is also a way out of one you were emulating.
  const user = session.user as { name?: string; email: string; admin?: boolean };
  if (user.admin) await leaveEmulation({ id: session.user.id, label: user.name || user.email });
  await setActiveOrganization(organizationId);
  revalidatePath("/", "layout");
  return { ok: true };
}
