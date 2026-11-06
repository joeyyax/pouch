"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { fieldClasses } from "@/components/ui/field";
import { FieldMessage } from "@/components/ui/field-message";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth/client";
import { cn } from "@/lib/utils";

export function ResetUnavailable() {
  return (
    <Callout tone="warn" title="Reset email isn't set up">
      This install can&apos;t send mail yet. An admin sets the system from address to an address on a verified
      domain in Admin settings → General, or sets a new password on the host with <code>pnpm reset:admin</code>.
    </Callout>
  );
}

type State = { kind: "idle" } | { kind: "sent"; email: string } | { kind: "unavailable" } | { kind: "error"; message: string };

export function ForgotPasswordForm() {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const email = String(new FormData(event.currentTarget).get("email") ?? "").trim();
    const result = await authClient.requestPasswordReset({ email });
    setPending(false);

    if (!result.error) return setState({ kind: "sent", email });
    if (result.error.status === 503) return setState({ kind: "unavailable" });
    if (result.error.status === 429) return setState({ kind: "error", message: result.error.message ?? "Too many reset requests." });
    setState({ kind: "error", message: "The reset request didn't go through. Try again." });
  }

  if (state.kind === "unavailable") return <ResetUnavailable />;

  if (state.kind === "sent") {
    return (
      <Callout tone="success" title="Check your email">
        If an account uses {state.email}, a reset link is on its way. It works once and expires in 1 hour.
      </Callout>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Email</Label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className={cn(fieldClasses({ shape: "compact", size: "md" }), "w-full")}
        />
      </div>
      {state.kind === "error" ? <FieldMessage tone="error">{state.message}</FieldMessage> : null}
      <Button type="submit" size="md" loading={pending} className="mt-1 w-full justify-center">
        Send reset link
      </Button>
    </form>
  );
}
