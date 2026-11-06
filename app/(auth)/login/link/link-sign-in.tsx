"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { FieldMessage } from "@/components/ui/field-message";
import { MagicLinkRequestForm } from "../magic-link-request";
import { signInWithLinkAction } from "./actions";

type State = "ready" | "invalid" | "error";

/** The expired, used or missing-link state, with a way to ask again. */
export function LinkExpired({ missing = false }: { missing?: boolean }) {
  return (
    <div className="flex flex-col gap-6">
      <Callout tone="danger" title={missing ? "This link has no token" : "This link has expired or was already used"}>
        {missing
          ? "Open the link from the sign-in email again, or request a new one."
          : "Sign-in links work once and expire after 10 minutes. Request a new one."}
      </Callout>
      <MagicLinkRequestForm />
      <p className="type-body-sm text-muted-foreground">
        <Link href="/login" className="text-primary-strong transition-colors hover:text-primary">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}

export function LinkSignIn({ token }: { token: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>("ready");
  const [pending, setPending] = useState(false);

  async function confirm() {
    setPending(true);
    const result = await signInWithLinkAction(token);
    if (result.ok) {
      router.push("/");
      router.refresh();
      return;
    }
    setPending(false);
    setState(result.reason);
  }

  if (state === "invalid") return <LinkExpired />;

  return (
    <div className="flex flex-col gap-4">
      <p className="type-body-sm text-muted-foreground">Confirm to finish signing in on this device.</p>
      {state === "error" ? <FieldMessage tone="error">The sign-in didn&apos;t go through. Try again.</FieldMessage> : null}
      <Button type="button" size="md" loading={pending} onClick={confirm} className="w-full justify-center">
        Sign in
      </Button>
    </div>
  );
}
