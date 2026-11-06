"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field, fieldClasses } from "@/components/ui/field";
import { FieldMessage } from "@/components/ui/field-message";
import { Icon } from "@/components/ui/icon";
import { authClient } from "@/lib/auth/client";
import { idle, type ActionState } from "@/lib/dashboard/action-state";
import { acceptInvitationAction } from "./actions";

/** Better Auth's default. */
const MIN_LENGTH = 8;

/** The ways in this install offers a new account. `link` is on only while system mail works. */
export interface AcceptMethods {
  password: boolean;
  passkey: boolean;
  link: boolean;
}

export function AcceptForm({ token, methods }: { token: string; methods: AcceptMethods }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(acceptInvitationAction, idle);
  const router = useRouter();
  const offerPasskey = !methods.password && methods.passkey;

  useEffect(() => {
    if (state.status === "ok" && !offerPasskey) {
      router.replace("/");
      router.refresh();
    }
  }, [state, router, offerPasskey]);

  if (state.status === "ok" && offerPasskey) return <AddPasskey canSkip={methods.link} />;

  const error = state.status === "error" ? state : null;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      <Field id="accept-name" label="Name" error={error?.field === "name" ? error.message : undefined}>
        <input
          id="accept-name"
          name="name"
          type="text"
          required
          maxLength={100}
          autoComplete="name"
          className={`${fieldClasses({ shape: "compact", size: "md" })} w-full`}
        />
      </Field>
      {methods.password ? (
        <>
          <Field
            id="accept-password"
            label="Password"
            hint={`At least ${MIN_LENGTH} characters.`}
            error={error?.field === "password" ? error.message : undefined}
          >
            <input
              id="accept-password"
              name="password"
              type="password"
              required
              minLength={MIN_LENGTH}
              autoComplete="new-password"
              className={`${fieldClasses({ shape: "compact", size: "md" })} w-full`}
            />
          </Field>
          <Field id="accept-confirm" label="Confirm password" error={error?.field === "confirm" ? error.message : undefined}>
            <input
              id="accept-confirm"
              name="confirm"
              type="password"
              required
              autoComplete="new-password"
              className={`${fieldClasses({ shape: "compact", size: "md" })} w-full`}
            />
          </Field>
        </>
      ) : null}
      {error && !error.field ? <FieldMessage tone="error">{error.message}</FieldMessage> : null}
      <Button type="submit" size="md" loading={pending} className="mt-1 w-full justify-center">
        Join
      </Button>
    </form>
  );
}

/** After joining without a password: a passkey to sign in next time, skippable while links work. */
function AddPasskey({ canSkip }: { canSkip: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function finish() {
    router.replace("/");
    router.refresh();
  }

  async function add() {
    setPending(true);
    setError(null);
    const result = await authClient.passkey.addPasskey();
    setPending(false);
    if (result?.error) return setError(result.error.message ?? "The passkey wasn't added. Try again.");
    finish();
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="type-body-sm text-muted-foreground">
        {canSkip
          ? "You're in. Add a passkey to sign in next time, or use a sign-in link emailed to you."
          : "You're in. Add a passkey now: it's how you sign in next time on this install."}
      </p>
      {error ? <FieldMessage tone="error">{error}</FieldMessage> : null}
      <Button type="button" size="md" loading={pending} onClick={add} className="w-full justify-center gap-2">
        <Icon name="key" className="size-4" />
        Add a passkey
      </Button>
      {canSkip ? (
        <Button type="button" variant="secondary" size="md" onClick={finish} className="w-full justify-center">
          Skip, I&apos;ll use sign-in links
        </Button>
      ) : null}
    </div>
  );
}
