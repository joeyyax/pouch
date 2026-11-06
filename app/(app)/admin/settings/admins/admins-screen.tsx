"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { AdminSummary } from "@/lib/dashboard/admins";
import { RoleGate } from "../../../_ui/role-gate";
import { SectionHeader } from "../../../_ui/section-header";
import { useOpenerFocus } from "@/hooks/use-opener-focus";
import { useAction } from "../../../_ui/use-action";
import { deleteAccountAction, demoteAdminAction } from "./actions";
import { AddAdminButton } from "./add-admin-dialog";

const SELF = "Another admin makes this change for your account.";

export function AdminsScreen({
  admins,
  currentUserId,
}: {
  admins: AdminSummary[];
  currentUserId: string;
}) {
  const demote = useAction(demoteAdminAction);
  const remove = useAction(deleteAccountAction);
  const [confirming, setConfirming] = useState<AdminSummary | null>(null);
  const [deleting, setDeleting] = useState<AdminSummary | null>(null);
  const opener = useOpenerFocus();

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        title="Admins"
        description="Admins reach every organization and these settings, with or without a membership."
        meta={`${admins.length} ${admins.length === 1 ? "admin" : "admins"}`}
        actions={<AddAdminButton />}
      />

      <Card className="overflow-hidden p-0">
        <ul>
          {admins.map((admin) => (
            <li
              key={admin.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5 last:border-b-0"
            >
              <div className="min-w-0">
                <p className="flex items-center gap-2 font-semibold text-foreground">
                  {admin.name}
                  {admin.id === currentUserId ? <Chip>you</Chip> : null}
                </p>
                <p className="type-body-sm font-mono text-muted-foreground">{admin.email}</p>
              </div>
              <div className="flex items-center gap-2">
                <RoleGate allowed={admin.id !== currentUserId} reason={SELF}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={(event) => {
                      opener.remember(event);
                      setConfirming(admin);
                    }}
                  >
                    Remove access
                  </Button>
                </RoleGate>
                <RoleGate allowed={admin.id !== currentUserId} reason={SELF}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={(event) => {
                      opener.remember(event);
                      setDeleting(admin);
                    }}
                  >
                    Delete account
                  </Button>
                </RoleGate>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        onCloseAutoFocus={opener.restore}
        title={deleting ? `Delete ${deleting.name}'s account?` : ""}
        consequence="They can't sign in again, and their sessions and memberships end. Their admin keys are revoked. Organization keys they created keep sending until you rotate them."
        confirmLabel="Delete account"
        tone="destructive"
        loading={remove.pending}
        onConfirm={() => {
          if (!deleting) return;
          const form = new FormData();
          form.set("id", deleting.id);
          remove.formAction(form);
          setDeleting(null);
        }}
      />

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        onCloseAutoFocus={opener.restore}
        title={confirming ? `Remove admin access for ${confirming.name}?` : ""}
        consequence="They lose admin access immediately. Their organization memberships stay."
        confirmLabel="Remove access"
        tone="destructive"
        loading={demote.pending}
        onConfirm={() => {
          if (!confirming) return;
          const form = new FormData();
          form.set("id", confirming.id);
          demote.formAction(form);
          setConfirming(null);
        }}
      />
    </section>
  );
}
