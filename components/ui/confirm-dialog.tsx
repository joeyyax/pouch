"use client";

import { useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";

// ConfirmDialog — the one recipe for "are you sure". The consequence line is
// required because that is the whole job: name what happens, in the same
// words the rest of the app uses, then confirm with a plain button. No
// retype-the-name gate — it slows the careful and stops nobody.
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  consequence,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  loading = false,
  onConfirm,
  onCloseAutoFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The question, as a question: "Revoke scope-production?" */
  title: ReactNode;
  /** What happens if they go ahead. Exact and scoped, not "this cannot be undone". */
  consequence: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "destructive";
  loading?: boolean;
  onConfirm: () => void;
  /** Where focus goes on close. Without it, focus falls to <body> when the trigger re-rendered. */
  onCloseAutoFocus?: (event: Event) => void;
  /** Anything the consequence line can't carry — a list of what gets revoked. */
  children?: ReactNode;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={title}
      initialFocus={cancelRef}
      onCloseAutoFocus={onCloseAutoFocus}
      description={consequence}
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" size="md" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "destructive" ? "danger" : "primary"}
            size="md"
            loading={loading}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
