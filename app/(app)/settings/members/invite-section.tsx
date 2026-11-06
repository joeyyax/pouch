"use client";

import { startTransition, useState } from "react";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { sentenceCase } from "@/components/ui/status-dot";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { InvitationView } from "@/lib/dashboard/views/invitations";
import { absoluteTime } from "@/lib/format/time";
import { useOpenerFocus } from "@/hooks/use-opener-focus";
import { RowActions } from "../../_ui/row-actions";
import { useAction } from "../../_ui/use-action";
import { useTimeZone } from "../../_ui/time-zone";
import { resendInvitationAction, revokeInvitationAction } from "../actions";

const OWNER_ONLY = "You need to be an owner to manage people.";

export function InviteSection({ invitations, canManage }: { invitations: InvitationView[]; canManage: boolean }) {
  const zone = useTimeZone();
  const resend = useAction(resendInvitationAction);
  const revoke = useAction(revokeInvitationAction);
  const [revoking, setRevoking] = useState<InvitationView | null>(null);
  const opener = useOpenerFocus();

  return (
    <div className="flex flex-col gap-3">
      {invitations.length > 0 ? (
        <Card className="overflow-hidden p-0">
          <ul>
            {invitations.map((invitation) => (
              <li
                key={invitation.id}
                className="group/row flex items-center justify-between gap-3 border-b border-border p-5 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-semibold text-foreground">
                    <span className="truncate font-mono type-body-sm">{invitation.email}</span>
                    <span className="type-body-sm font-normal text-muted-foreground">{sentenceCase(invitation.role)}</span>
                    {invitation.expired ? <Chip tone="issue">expired</Chip> : null}
                  </p>
                  <p className="type-body-sm text-muted-foreground">
                    {invitation.expired ? "Expired " : "Expires "}
                    <time dateTime={invitation.expiresAt}>{absoluteTime(new Date(invitation.expiresAt), zone)}</time>
                  </p>
                </div>
                <RowActions
                  label={`Actions for the invitation to ${invitation.email}`}
                  // An expired invitation's fix is Resend, so it stays in view.
                  className={invitation.expired ? "opacity-100" : undefined}
                  actions={[
                    {
                      label: "Resend",
                      disabled: !canManage || resend.pending,
                      reason: canManage ? undefined : OWNER_ONLY,
                      onSelect: () => {
                        const data = new FormData();
                        data.set("invitationId", invitation.id);
                        startTransition(() => resend.formAction(data));
                      },
                    },
                    {
                      label: "Revoke",
                      destructive: true,
                      disabled: !canManage,
                      reason: OWNER_ONLY,
                      onSelect: (event) => {
                        opener.remember(event);
                        setRevoking(invitation);
                      },
                    },
                  ]}
                />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        onCloseAutoFocus={opener.restore}
        title={revoking ? `Revoke the invitation to ${revoking.email}?` : ""}
        consequence="The link in their email stops working immediately. You can invite them again."
        confirmLabel="Revoke"
        tone="destructive"
        loading={revoke.pending}
        onConfirm={() => {
          if (!revoking) return;
          const data = new FormData();
          data.set("invitationId", revoking.id);
          startTransition(() => revoke.formAction(data));
          setRevoking(null);
        }}
      />
    </div>
  );
}
