import { isOrgOwner } from "@/lib/auth/permissions";
import { requireOrganization } from "@/lib/dashboard/session";
import { loadOpenInvitations } from "@/lib/dashboard/invitations";
import { listMembers } from "@/lib/memberships";
import { SectionHeader } from "../../_ui/section-header";
import { AddMemberButton } from "./add-member-dialog";
import { InviteSection } from "./invite-section";
import { MembersSection } from "./members-section";

export const dynamic = "force-dynamic";

export default async function SettingsMembersPage() {
  const session = await requireOrganization();
  const [members, invitations] = await Promise.all([
    listMembers(session.organizationId, { limit: 200 }),
    loadOpenInvitations(session.organizationId),
  ]);
  const canManage = isOrgOwner(session.role);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <SectionHeader
          title="Members"
          description="Owners manage people and settings. Members do the sending work."
          actions={<AddMemberButton canManage={canManage} />}
        />
        <MembersSection members={members.data} currentUserId={session.userId} canManage={canManage} />
      </section>
      {invitations.length > 0 ? (
        <section className="flex flex-col gap-3">
          <SectionHeader
            title="Invitations"
            description="Each link works once and expires in 7 days."
          />
          <InviteSection invitations={invitations} canManage={canManage} />
        </section>
      ) : null}
    </div>
  );
}
