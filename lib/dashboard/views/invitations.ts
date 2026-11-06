import type { OrgRole } from "@/lib/auth/permissions";

/** One open invitation, as the Members screen renders it. */
export interface InvitationView {
  id: string;
  email: string;
  role: OrgRole;
  expired: boolean;
  expiresAt: string;
  invitedAt: string;
}
