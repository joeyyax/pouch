import { listOpenInvitations } from "@/lib/invitations";
import type { InvitationView } from "./views/invitations";

/** Invitations still awaiting a redemption, expired ones included so they can be resent. */
export async function loadOpenInvitations(organizationId: string): Promise<InvitationView[]> {
  const rows = await listOpenInvitations(organizationId);
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    expired: row.status === "expired",
    expiresAt: row.expires_at,
    invitedAt: row.created_at,
  }));
}
