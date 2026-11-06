"use client";

import { keepValues } from "../../../_ui/keep-values";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, fieldClasses } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useOpenerFocus } from "@/hooks/use-opener-focus";
import { toast } from "@/lib/toast";
import { toastError, useAction } from "../../../_ui/use-action";
import { promoteAdminAction } from "./actions";

export function AddAdminButton() {
  const [open, setOpen] = useState(false);
  const opener = useOpenerFocus();

  return (
    <>
      <Button
        type="button"
        size="md"
        onClick={(event) => {
          opener.remember(event);
          setOpen(true);
        }}
      >
        Add admin
      </Button>
      {open ? <AddAdminDialog onClose={() => setOpen(false)} onCloseAutoFocus={opener.restore} /> : null}
    </>
  );
}

function AddAdminDialog({ onClose, onCloseAutoFocus }: { onClose: () => void; onCloseAutoFocus: (event: Event) => void }) {
  const promote = useAction(promoteAdminAction, (state) => {
    if (state.status === "error" && !state.field) toastError(state);
    if (state.status === "ok") {
      toast({ title: state.message, variant: "success" });
      onClose();
    }
  });
  const error = promote.state.status === "error" ? promote.state : null;

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      onCloseAutoFocus={onCloseAutoFocus}
      title="Add admin"
      description="The account has to exist already."
    >
      <form onSubmit={keepValues(promote.formAction)} className="flex flex-col gap-5">
        <Field
          id="admin-email"
          label="Email"
          hint="They don't need a membership in any organization."
          error={error?.field === "email" ? error.message : undefined}
        >
          <input
            id="admin-email"
            name="email"
            type="email"
            required
            autoFocus
            placeholder="person@example.com"
            className={`${fieldClasses({ shape: "compact", size: "md" })} w-full`}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="md" loading={promote.pending}>
            Grant access
          </Button>
        </div>
      </form>
    </Modal>
  );
}
