/**
 * Password reset by email, sent from the system from address (#282, #379). Better Auth owns the
 * token; this adapter owns the mail, the activity rows and the guard in front of the request.
 */
import { createHash } from "node:crypto";
import { recordActivity, userActor } from "@/lib/activity/record";
import { clientIpBucket } from "@/lib/api/client-ip";
import { consumeRateLimit, type RateLimitResult } from "@/lib/api/rate-limit";
import { brand } from "@/lib/brand";
import { onShutdown } from "@/lib/lifecycle";
import { logger } from "@/lib/logger";
import { sendSystemMail, systemMailReady } from "@/lib/mail/system";
import { createElement } from "react";
import { SystemMail, type SystemMailBody } from "@/lib/mail/template";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("password-reset");

/** One hour, Better Auth's default. */
export const RESET_TOKEN_TTL_SECONDS = 60 * 60;

export const REQUEST_PASSWORD_RESET_PATH = "/api/auth/request-password-reset";
export const RESET_PASSWORD_PAGE = "/reset-password";

export const PASSWORD_RESET_UNAVAILABLE_MESSAGE =
  "Password reset email isn't set up on this install. An admin sets the system from address to an address on a verified domain in Admin settings → General, or resets the password on the host with `pnpm reset:admin`.";

/** Requests allowed per minute from one client address. */
function perAddressLimit(): number {
  return Number(process.env.PASSWORD_RESET_RATE_LIMIT ?? "5");
}

/** Requests allowed per minute for one email address, whoever asks. */
function perEmailLimit(): number {
  return Number(process.env.PASSWORD_RESET_EMAIL_RATE_LIMIT ?? "3");
}

interface ResetUser {
  id: string;
  email: string;
  name?: string | null;
  organizationId?: string;
}

function actorFor(user: ResetUser) {
  return userActor(user.id, user.name || user.email);
}

/** The link in the email: the app's own page, not Better Auth's redirect endpoint. */
export function resetLinkFor(betterAuthUrl: string, token: string): string {
  const link = new URL(RESET_PASSWORD_PAGE, new URL(betterAuthUrl).origin);
  link.searchParams.set("token", token);
  return link.toString();
}

export function resetMail(email: string, link: string): SystemMailBody {
  return {
    heading: "Reset your password",
    paragraphs: [`Someone asked to reset the password for ${email} on ${brand.name}.`],
    action: { label: "Choose a new password", url: link },
    note: "The link works once and expires in 1 hour.",
    reason: "Didn't ask? Ignore this email. Your password stays the same.",
  };
}

/** Better Auth's `sendResetPassword`. Never throws: a failure here must look like a success to the requester. */
export async function sendPasswordResetMail(data: { user: ResetUser; url: string; token: string }): Promise<void> {
  const { user, url, token } = data;
  try {
    await sendSystemMail({
      to: user.email,
      subject: `Reset your ${brand.name} password`,
      email: createElement(SystemMail, resetMail(user.email, resetLinkFor(url, token))),
      tags: ["password-reset"],
      withhold: "a password reset link",
      idempotencyKey: `password-reset:${createHash("sha256").update(token).digest("hex")}`,
    });
  } catch (error) {
    log.error(`reset mail failed user=${user.id}: ${safeErrorMessage(error)}`);
    return;
  }
  if (user.organizationId) {
    await recordActivity({ organizationId: user.organizationId, action: "session.password_reset.requested", actor: actorFor(user) });
  }
}

/** Better Auth's `onPasswordReset`. */
export async function recordPasswordReset({ user }: { user: ResetUser }): Promise<void> {
  if (!user.organizationId) return;
  await recordActivity({ organizationId: user.organizationId, action: "session.password_reset.completed", actor: actorFor(user) });
}

export function emailBucket(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

export async function readEmail(request: Request): Promise<string | null> {
  try {
    const body = (await request.clone().json()) as { email?: unknown };
    return typeof body.email === "string" ? body.email : null;
  } catch {
    return null;
  }
}

export function tooMany(result: RateLimitResult, what = "reset"): Response {
  const retryAfter = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
  return Response.json(
    { code: "TOO_MANY_REQUESTS", message: `Too many ${what} requests. Retry after ${retryAfter} seconds.` },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}

/**
 * Runs before Better Auth handles a reset request. Returns a response to send instead, or null
 * to let the request through. Counts every request, so a limit reveals nothing about the address.
 */
export async function guardPasswordResetRequest(request: Request): Promise<Response | null> {
  const byClient = await consumeRateLimit(`password-reset:ip:${clientIpBucket(request)}`, perAddressLimit());
  if (byClient.exceeded) return tooMany(byClient);

  const email = await readEmail(request);
  if (email) {
    const byEmail = await consumeRateLimit(`password-reset:email:${emailBucket(email)}`, perEmailLimit());
    if (byEmail.exceeded) return tooMany(byEmail);
  }

  if (!(await systemMailReady())) {
    return Response.json({ code: "PASSWORD_RESET_UNAVAILABLE", message: PASSWORD_RESET_UNAVAILABLE_MESSAGE }, { status: 503 });
  }
  return null;
}

const pending = new Set<Promise<unknown>>();

/** Better Auth's background task handler, so a send doesn't make a known address answer slower. */
export function runAuthTaskInBackground(promise: Promise<unknown>): void {
  onShutdown("app:auth-tasks", settleAuthBackgroundTasks, { drain: true, timeoutMs: 8000 });
  const tracked = promise.catch(() => {}).finally(() => pending.delete(tracked));
  pending.add(tracked);
}

/** Waits for every background task started so far. */
export async function settleAuthBackgroundTasks(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}
