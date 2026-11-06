"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { fieldClasses } from "@/components/ui/field";
import { FieldMessage } from "@/components/ui/field-message";
import { Icon } from "@/components/ui/icon";
import { Label } from "@/components/ui/label";
import { signIn } from "@/lib/auth/client";
import { cn } from "@/lib/utils";
import { recordSignInAction } from "./actions";
import type { SignInMethods } from "@/lib/auth/sign-in-methods";
import { loginMethods, otherWays, PASSWORD_METHOD } from "./login-methods";
import { MagicLinkSent, requestMagicLink, type LinkRequest } from "./magic-link-request";

/** A refused passkey is the server's 401; anything else is the browser's ceremony ending early. */
function passkeyMessage(error: { status?: number }, others: string): string {
  return error.status === 401 ? `That passkey isn't registered here.${others}` : `Passkey sign-in didn't finish. Try again.${others}`;
}

export function LoginForm({ enabled, mailReady, method }: { enabled: SignInMethods; mailReady: boolean; method?: string }) {
  const methods = loginMethods(enabled, mailReady, method);
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const [passwordOpen, setPasswordOpen] = useState(methods.passwordOpen);
  const [focusPassword, setFocusPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [passkeyPending, setPasskeyPending] = useState(false);
  const browserPasskeys = useSyncExternalStore(
    () => () => {},
    () => typeof window.PublicKeyCredential !== "undefined",
    () => false,
  );
  const passkeys = methods.passkeyOffered && browserPasskeys;
  const [linkPending, setLinkPending] = useState(false);
  const [link, setLink] = useState<LinkRequest>({ kind: "idle" });

  const finish = useCallback(() => {
    router.push("/");
    router.refresh();
  }, [router]);

  // Browser autofill offers the account's passkeys in the email field. It waits until one is
  // picked; a cancelled or replaced ceremony ends without a message.
  const offerAutofill = useCallback(async () => {
    if (!(await PublicKeyCredential.isConditionalMediationAvailable?.())) return;
    const result = await signIn.passkey({ autoFill: true });
    if (result?.data) finish();
  }, [finish]);

  useEffect(() => {
    if (passkeys) void offerAutofill().catch(() => {});
  }, [passkeys, offerAutofill]);

  // Moves focus to the field the person just asked for.
  useEffect(() => {
    if (focusPassword && passwordOpen) password.current?.focus();
  }, [focusPassword, passwordOpen]);

  // The address carries the choice, so a link or a password manager can open either.
  function choose(open: boolean) {
    setPasswordOpen(open);
    setFocusPassword(open);
    setError(null);
    window.history.replaceState(null, "", open ? `/login?method=${PASSWORD_METHOD}` : "/login");
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!passwordOpen) return methods.linkOffered ? onLink() : onPasskey();
    setPending(true);
    setError(null);

    const data = new FormData(event.currentTarget);
    const result = await signIn.email({
      email: String(data.get("email") ?? ""),
      password: String(data.get("password") ?? ""),
    });

    setPending(false);
    if (result.error) {
      setError("That email and password don't match an account.");
      return;
    }
    void recordSignInAction();
    finish();
  }

  // The server records a passkey sign-in itself, so there's no `recordSignInAction` here.
  async function onPasskey() {
    setPasskeyPending(true);
    setError(null);
    const result = await signIn.passkey();
    setPasskeyPending(false);
    if (result.error || !result.data) {
      setError(passkeyMessage(result.error ?? {}, otherWays(methods)));
      void offerAutofill().catch(() => {});
      return;
    }
    finish();
  }

  async function onLink() {
    const email = form.current?.elements.namedItem("email") as HTMLInputElement | null;
    if (!email || !email.reportValidity()) return;
    setLinkPending(true);
    setError(null);
    const result = await requestMagicLink(email.value.trim());
    setLinkPending(false);
    if (result.kind === "error") return setError(result.message);
    setLink(result);
  }

  if (link.kind === "sent") {
    return (
      <MagicLinkSent email={link.email}>
        <Button type="button" variant="secondary" size="md" onClick={() => setLink({ kind: "idle" })} className="w-full justify-center">
          Use another way to sign in
        </Button>
      </MagicLinkSent>
    );
  }

  const linkButton = (primary: boolean) => (
    <Button
      type={primary ? "submit" : "button"}
      variant={primary ? "primary" : "secondary"}
      size="md"
      loading={linkPending}
      onClick={primary ? undefined : onLink}
      className={cn("w-full justify-center gap-2", primary && "mt-1")}
    >
      <Icon name="mail" className="size-4" />
      Email me a sign-in link
    </Button>
  );

  // The primary action when it's the only method on offer.
  const passkeyOnly = !passwordOpen && !methods.linkOffered;
  const passkeyButton = passkeys ? (
    <Button
      type={passkeyOnly ? "submit" : "button"}
      variant={passkeyOnly ? "primary" : "secondary"}
      size="md"
      loading={passkeyPending}
      onClick={passkeyOnly ? undefined : onPasskey}
      className={cn("w-full justify-center gap-2", passkeyOnly && "mt-1")}
    >
      <Icon name="key" className="size-4" />
      Sign in with a passkey
    </Button>
  ) : null;

  const switchLink = "type-body-sm self-start text-primary-strong transition-colors hover:text-primary";

  return (
    <form ref={form} onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Email</Label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email webauthn"
          required={!passkeyOnly}
          className={cn(fieldClasses({ shape: "compact", size: "md" }), "w-full")}
        />
      </div>
      {passwordOpen ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <Label htmlFor="password">Password</Label>
            <Link href="/forgot-password" className="type-body-sm text-primary-strong transition-colors hover:text-primary">
              Forgot password?
            </Link>
          </div>
          <input
            ref={password}
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className={cn(fieldClasses({ shape: "compact", size: "md" }), "w-full")}
          />
        </div>
      ) : null}
      {error ? <FieldMessage tone="error">{error}</FieldMessage> : null}
      {passwordOpen ? (
        <Button type="submit" size="md" loading={pending} className="mt-1 w-full justify-center">
          Sign in
        </Button>
      ) : methods.linkOffered ? (
        linkButton(true)
      ) : null}
      {passwordOpen && methods.linkOffered ? linkButton(false) : null}
      {passkeyButton}
      {methods.canToggle ? (
        <button type="button" className={switchLink} onClick={() => choose(!passwordOpen)}>
          {passwordOpen ? "Use a sign-in link instead" : "Use a password instead"}
        </button>
      ) : null}
    </form>
  );
}
