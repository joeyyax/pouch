"use client";

import { keepValues } from "../../_ui/keep-values";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, fieldClasses } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { SelectContent, SelectItem, SelectRoot, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ROLES } from "@/lib/auth/permissions";
import { useOpenerFocus } from "@/hooks/use-opener-focus";
import { RoleGate } from "../../_ui/role-gate";
import { toast } from "@/lib/toast";
import { toastError, useAction } from "../../_ui/use-action";
import { inviteMemberAction } from "../actions";

const OWNER_ONLY = "You need to be an owner to manage people.";

export function AddMemberButton({ canManage }: { canManage: boolean }) {
  const [open, setOpen] = useState(false);
  const opener = useOpenerFocus();

  return (
    <>
      <RoleGate allowed={canManage} reason={OWNER_ONLY}>
        <Button
          type="button"
          size="md"
          onClick={(event) => {
            opener.remember(event);
            setOpen(true);
          }}
        >
          Add member
        </Button>
      </RoleGate>
      {open ? <AddMemberDialog onClose={() => setOpen(false)} onCloseAutoFocus={opener.restore} /> : null}
    </>
  );
}

function AddMemberDialog({ onClose, onCloseAutoFocus }: { onClose: () => void; onCloseAutoFocus: (event: Event) => void }) {
  const invite = useAction(inviteMemberAction, (state) => {
    if (state.status === "error" && !state.field) toastError(state);
    if (state.status === "ok") {
      toast({ title: state.message, variant: "success" });
      onClose();
    }
  });
  const [role, setRole] = useState<string>(ROLES.MEMBER);
  const error = invite.state.status === "error" ? invite.state : null;

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      onCloseAutoFocus={onCloseAutoFocus}
      title="Add member"
      description="They get a link that works once and expires in 7 days."
    >
      <form onSubmit={keepValues(invite.formAction, { role })} className="flex flex-col gap-5">
        <Field id="invite-email" label="Email" error={error?.field === "email" ? error.message : undefined}>
          <input
            id="invite-email"
            name="email"
            type="email"
            required
            autoFocus
            placeholder="ada@example.com"
            className={`${fieldClasses({ shape: "compact", size: "md" })} w-full`}
          />
        </Field>
        <Field
          id="invite-role"
          label="Role"
          hint="Owners manage people and settings. Members do the sending work."
          error={error?.field === "role" ? error.message : undefined}
        >
          <SelectRoot value={role} onValueChange={setRole}>
            <SelectTrigger id="invite-role" shape="compact" size="md">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ROLES.MEMBER}>Member</SelectItem>
              <SelectItem value={ROLES.OWNER}>Owner</SelectItem>
            </SelectContent>
          </SelectRoot>
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="md" loading={invite.pending}>
            Send invitation
          </Button>
        </div>
      </form>
    </Modal>
  );
}
