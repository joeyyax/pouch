"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { fieldClasses } from "@/components/ui/field";
import { FieldMessage } from "@/components/ui/field-message";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth/client";
import { cn } from "@/lib/utils";

export type LinkRequest =
  | { kind: "idle" }
  | { kind: "sent"; email: string }
  | { kind: "error"; message: string };

/** Asks for a sign-in link. A link request answers the same for every address, so `sent` says nothing about the account. */
export async function requestMagicLink(email: string): Promise<LinkRequest> {
  const result = await authClient.signIn.magicLink({ email });
  if (!result.error) return { kind: "sent", email };
  if (result.error.status === 503) return { kind: "error", message: "Sign-in links aren't set up on this install." };
  if (result.error.status === 429) return { kind: "error", message: result.error.message ?? "Too many sign-in link requests." };
  return { kind: "error", message: "The sign-in link request didn't go through. Try again." };
}

export function MagicLinkSent({ email, children }: { email: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <Callout tone="success" title="Check your email">
        If an account uses {email}, a sign-in link is on its way. It works once and expires in 10 minutes.
      </Callout>
      {children}
    </div>
  );
}

/** An email field and a send button, for screens that offer a link and nothing else. */
export function MagicLinkRequestForm({ label = "Email me a new link" }: { label?: string }) {
  const [state, setState] = useState<LinkRequest>({ kind: "idle" });
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const email = String(new FormData(event.currentTarget).get("email") ?? "").trim();
    setState(await requestMagicLink(email));
    setPending(false);
  }

  if (state.kind === "sent") return <MagicLinkSent email={state.email} />;

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
      <Button type="submit" size="md" loading={pending} className="w-full justify-center">
        {label}
      </Button>
    </form>
  );
}
