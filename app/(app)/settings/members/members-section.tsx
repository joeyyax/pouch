"use client";

import { startTransition, useState } from "react";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { sentenceCase } from "@/components/ui/status-dot";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ROLES } from "@/lib/auth/permissions";
import type { SerializedMember } from "@/lib/memberships";
import { useOpenerFocus } from "@/hooks/use-opener-focus";
import { RowActions } from "../../_ui/row-actions";
import { useAction } from "../../_ui/use-action";
import { removeMemberAction, updateMemberRoleAction } from "../actions";

const OWNER_ONLY = "You need to be an owner to manage people.";

export function MembersSection({
  members,
  currentUserId,
  canManage,
}: {
  members: SerializedMember[];
  currentUserId: string;
  canManage: boolean;
}) {
  const setRole = useAction(updateMemberRoleAction);
  const remove = useAction(removeMemberAction);
  const [removing, setRemoving] = useState<SerializedMember | null>(null);
  const opener = useOpenerFocus();

  return (
    <>
      <Card className="overflow-hidden p-0">
        <ul>
          {members.map((member) => {
            const nextRole = member.role === ROLES.OWNER ? ROLES.MEMBER : ROLES.OWNER;
            return (
              <li
                key={member.user_id}
                className="group/row flex items-center justify-between gap-3 border-b border-border p-5 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-semibold text-foreground">
                    {member.name}
                    {member.user_id === currentUserId ? <Chip>you</Chip> : null}
                    <span className="type-body-sm font-normal text-muted-foreground">{sentenceCase(member.role)}</span>
                  </p>
                  <p className="type-body-sm truncate font-mono text-muted-foreground">{member.email}</p>
                </div>
                <RowActions
                  label={`Actions for ${member.name}`}
                  actions={[
                    {
                      label: nextRole === ROLES.OWNER ? "Make owner" : "Make member",
                      disabled: !canManage || setRole.pending,
                      reason: canManage ? undefined : OWNER_ONLY,
                      onSelect: () => {
                        const form = new FormData();
                        form.set("userId", member.user_id);
                        form.set("role", nextRole);
                        startTransition(() => setRole.formAction(form));
                      },
                    },
                    {
                      label: "Remove",
                      destructive: true,
                      disabled: !canManage,
                      reason: OWNER_ONLY,
                      onSelect: (event) => {
                        opener.remember(event);
                        setRemoving(member);
                      },
                    },
                  ]}
                />
              </li>
            );
          })}
        </ul>
      </Card>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        onCloseAutoFocus={opener.restore}
        title={removing ? `Remove ${removing.name} from this organization?` : ""}
        consequence="They lose access immediately. Their account and other organizations are unaffected."
        confirmLabel="Remove"
        tone="destructive"
        loading={remove.pending}
        onConfirm={() => {
          if (!removing) return;
          const form = new FormData();
          form.set("userId", removing.user_id);
          startTransition(() => remove.formAction(form));
          setRemoving(null);
        }}
      >
        <p className="type-body-sm text-muted-foreground">
          Keys they created keep sending until you rotate them.
        </p>
      </ConfirmDialog>
    </>
  );
}
