"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { fieldClasses } from "@/components/ui/field";
import { FieldMessage } from "@/components/ui/field-message";
import { Label } from "@/components/ui/label";
import { TextLink } from "@/components/ui/text-link";
import { authClient } from "@/lib/auth/client";
import { cn } from "@/lib/utils";

/** Better Auth's default. */
const MIN_LENGTH = 8;

type State = { kind: "idle" } | { kind: "done" } | { kind: "expired" } | { kind: "error"; message: string };

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("password") ?? "");
    if (newPassword !== String(form.get("confirm") ?? "")) {
      return setState({ kind: "error", message: "The passwords don't match." });
    }

    setPending(true);
    const result = await authClient.resetPassword({ newPassword, token });
    setPending(false);

    if (!result.error) return setState({ kind: "done" });
    if (result.error.code === "INVALID_TOKEN") return setState({ kind: "expired" });
    if (result.error.code === "PASSWORD_TOO_SHORT") {
      return setState({ kind: "error", message: `Use at least ${MIN_LENGTH} characters.` });
    }
    setState({ kind: "error", message: result.error.message ?? "The password didn't change. Try again." });
  }

  if (state.kind === "done") {
    return (
      <Callout tone="success" title="Password changed">
        Every session on this account is signed out. <TextLink href="/login">Sign in</TextLink> with the new password.
      </Callout>
    );
  }

  if (state.kind === "expired") {
    return (
      <Callout tone="danger" title="This link has expired or was already used">
        <TextLink href="/forgot-password">Request a new one</TextLink>.
      </Callout>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">New password</Label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={MIN_LENGTH}
          required
          aria-describedby="password-hint"
          className={cn(fieldClasses({ shape: "compact", size: "md" }), "w-full")}
        />
        <FieldMessage id="password-hint">At least {MIN_LENGTH} characters.</FieldMessage>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="confirm">Confirm new password</Label>
        <input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          className={cn(fieldClasses({ shape: "compact", size: "md" }), "w-full")}
        />
      </div>
      {state.kind === "error" ? <FieldMessage tone="error">{state.message}</FieldMessage> : null}
      <Button type="submit" size="md" loading={pending} className="mt-1 w-full justify-center">
        Change password
      </Button>
    </form>
  );
}
