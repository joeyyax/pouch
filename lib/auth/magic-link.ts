/**
 * Sign-in by emailed link, sent from the system from address. Better Auth owns the token; this
 * adapter owns the mail, the activity row and the guard in front of the request. A link never
 * creates an account: an address with no user gets the same answer and no mail.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { recordActivity, userActor } from "@/lib/activity/record";
import { clientIpBucket, clientOf } from "@/lib/api/client-ip";
import { consumeRateLimit } from "@/lib/api/rate-limit";
import { brand } from "@/lib/brand";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { sendSystemMail, systemMailReady } from "@/lib/mail/system";
import { SystemMail, type SystemMailBody } from "@/lib/mail/template";
import { emailBucket, readEmail, runAuthTaskInBackground, tooMany } from "./password-reset";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("magic-link");

/** Ten minutes. */
export const MAGIC_LINK_TTL_SECONDS = 10 * 60;

export const REQUEST_MAGIC_LINK_PATH = "/api/auth/sign-in/magic-link";
export const MAGIC_LINK_PAGE = "/login/link";

export const MAGIC_LINK_UNAVAILABLE_MESSAGE =
  "Sign-in links need system mail, which isn't set up on this install. An admin sets the system from address to an address on a verified domain in Admin settings → General.";

/** Requests allowed per minute from one client address. */
function perAddressLimit(): number {
  return Number(process.env.MAGIC_LINK_RATE_LIMIT ?? "5");
}

/** Requests allowed per minute for one email address, whoever asks. */
function perEmailLimit(): number {
  return Number(process.env.MAGIC_LINK_EMAIL_RATE_LIMIT ?? "3");
}

/** The link in the email: the app's own confirm page, not Better Auth's verify endpoint. */
export function magicLinkFor(betterAuthUrl: string, token: string): string {
  const link = new URL(MAGIC_LINK_PAGE, new URL(betterAuthUrl).origin);
  link.searchParams.set("token", token);
  return link.toString();
}

export function magicLinkMail(email: string, link: string): SystemMailBody {
  return {
    heading: `Sign in to ${brand.name}`,
    paragraphs: [`Someone asked to sign in to ${brand.name} as ${email}.`],
    action: { label: "Sign in", url: link },
    note: "The link works once and expires in 10 minutes.",
    reason: "Didn't ask? Ignore this email. Nothing changes without the link.",
  };
}

async function accountFor(email: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1);
  return user ?? null;
}

/** Better Auth's `sendMagicLink`. Never throws, and sends nothing for an address with no account. */
export async function sendMagicLinkMail(
  data: { email: string; url: string; token: string },
  ctx?: { headers?: Headers },
): Promise<void> {
  const send = async () => {
    const user = await accountFor(data.email);
    if (!user) return;
    try {
      await sendSystemMail({
        to: user.email,
        subject: `Sign in to ${brand.name}`,
        email: createElement(SystemMail, magicLinkMail(user.email, magicLinkFor(data.url, data.token))),
        tags: ["magic-link"],
        withhold: "a sign-in link",
        idempotencyKey: `magic-link:${createHash("sha256").update(data.token).digest("hex")}`,
      });
    } catch (error) {
      log.error(`link mail failed user=${user.id}: ${safeErrorMessage(error)}`);
      return;
    }
    await recordActivity({
      organizationId: user.organizationId,
      action: "session.magic_link.requested",
      actor: userActor(user.id, user.name || user.email),
      client: ctx?.headers ? clientOf({ headers: ctx.headers }) : undefined,
    });
  };
  runAuthTaskInBackground(send());
}

/**
 * Runs before Better Auth handles a link request. Returns the response to send instead, or null
 * to let it through. Counts every request, and answers an address with no account exactly as it
 * answers one with an account, so neither the limit nor the reply reveals which is which.
 */
export async function guardMagicLinkRequest(request: Request): Promise<Response | null> {
  const byClient = await consumeRateLimit(`magic-link:ip:${clientIpBucket(request)}`, perAddressLimit());
  if (byClient.exceeded) return tooMany(byClient, "sign-in link");

  const email = await readEmail(request);
  if (email) {
    const byEmail = await consumeRateLimit(`magic-link:email:${emailBucket(email)}`, perEmailLimit());
    if (byEmail.exceeded) return tooMany(byEmail, "sign-in link");
  }

  if (!(await systemMailReady())) {
    return Response.json({ code: "MAGIC_LINK_UNAVAILABLE", message: MAGIC_LINK_UNAVAILABLE_MESSAGE }, { status: 503 });
  }
  if (email && !(await accountFor(email))) return Response.json({ status: true });
  return null;
}
