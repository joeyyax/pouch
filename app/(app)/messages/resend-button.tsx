"use client";

import { startTransition } from "react";
import { Button } from "@/components/ui/button";
import { TextLink } from "@/components/ui/text-link";
import { RoleGate } from "../_ui/role-gate";
import { toastError, useAction } from "../_ui/use-action";
import { resendMessageAction } from "./actions";

/** Resend, off with the reason when the body can't be resent. After a resend, links to the copy. */
export function ResendButton({ messageId, blocked }: { messageId: string; blocked: string | null }) {
  const resend = useAction(resendMessageAction, toastError);
  const copyHref = resend.state.status === "ok" ? resend.state.href : undefined;

  return (
    <span className="flex items-center gap-3">
      {copyHref ? (
        <span role="status" className="type-body-sm text-foreground-soft">
          Resent. <TextLink href={copyHref}>Open the copy</TextLink>
        </span>
      ) : null}
      <RoleGate allowed={blocked === null} reason={blocked ?? ""}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={resend.pending}
          aria-description={blocked ?? undefined}
          onClick={() => {
            const data = new FormData();
            data.set("messageId", messageId);
            startTransition(() => resend.formAction(data));
          }}
        >
          Resend
        </Button>
      </RoleGate>
    </span>
  );
}
