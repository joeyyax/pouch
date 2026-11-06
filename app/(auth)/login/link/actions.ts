"use server";

/**
 * Redeems a sign-in link. The email opens a confirm page and this runs on its button, so a mail
 * scanner that fetches the URL can't spend the link. Better Auth's `/magic-link/verify` does the
 * work, and its after hook records `session.signed_in` from the session it starts.
 */
import { headers } from "next/headers";
import { isAPIError } from "better-auth/api";
import { auth } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { safeErrorMessage } from "@/lib/errors/scrub";

export type RedeemResult = { ok: true } | { ok: false; reason: "invalid" | "error" };

export async function signInWithLinkAction(token: string): Promise<RedeemResult> {
  if (!token) return { ok: false, reason: "invalid" };
  try {
    await auth.api.magicLinkVerify({ query: { token }, headers: await headers() });
    return { ok: true };
  } catch (error) {
    // A refused link is a redirect to the error callback; anything else is the server's fault.
    if (isAPIError(error)) return { ok: false, reason: "invalid" };
    logger.child("magic-link").error(`redeeming a link failed: ${safeErrorMessage(error)}`);
    return { ok: false, reason: "error" };
  }
}
