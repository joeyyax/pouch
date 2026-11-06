import type { SignInMethods } from "@/lib/auth/sign-in-methods";

/** What /login offers. A sign-in link leads; a password is the alternative; a method that's off is absent. */
export interface LoginMethods {
  /** The password form is offered at all. */
  passwordOffered: boolean;
  /** The password field starts open. */
  passwordOpen: boolean;
  /** "Email me a sign-in link" is offered at all. Never a dead button: without system mail it's absent. */
  linkOffered: boolean;
  /** "Sign in with a passkey" and passkey autofill. */
  passkeyOffered: boolean;
  /** The person can switch between the link and the password, so a toggle shows. */
  canToggle: boolean;
}

/** `method` is the page's `?method=` value. */
export function loginMethods(enabled: SignInMethods, mailReady: boolean, method: string | undefined): LoginMethods {
  const linkOffered = enabled.magic_link && mailReady;
  const passwordOffered = enabled.password;
  return {
    passwordOffered,
    passwordOpen: passwordOffered && (!linkOffered || method === PASSWORD_METHOD),
    linkOffered,
    passkeyOffered: enabled.passkey,
    canToggle: passwordOffered && linkOffered,
  };
}

/** What a refused passkey suggests instead, from the other methods on offer. */
export function otherWays(methods: LoginMethods): string {
  if (methods.passwordOffered && methods.linkOffered) return " Use your password or a sign-in link.";
  if (methods.passwordOffered) return " Use your password.";
  if (methods.linkOffered) return " Use a sign-in link.";
  return "";
}

export const PASSWORD_METHOD = "password";
