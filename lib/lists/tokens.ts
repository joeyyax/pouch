/**
 * Signed links for double opt-in confirmation and unsubscribe (#7). Same HMAC-SHA256 +
 * `timingSafeEqual` idiom as the digest unsubscribe token (`lib/mail/digest/unsubscribe.ts`),
 * reused rather than invented twice — but keyed on an opaque row id, not the address. A list
 * membership already identifies exactly one list and one address (it's the row's own unique
 * key), so encoding its id is enough to scope the token the way the spec requires, and —
 * unlike embedding the address itself, even base64'd — an opaque internal id put in a URL
 * discloses nothing if the link leaks in a proxy log, a browser history entry or a screenshot.
 *
 * A batch sent to inline `recipients` (no list — see lib/bulk/create.ts) has no membership row
 * to key off, so its unsubscribe link signs the *message* id instead and scopes to the domain
 * rather than a list on redemption. Same function, same guarantee: the id is generic, not
 * specific to a membership, so both callers share one signer.
 *
 * `purpose` keeps a confirmation link from being replayable as an unsubscribe link and back:
 * they're signed over different material, so a token minted for one never verifies as the other.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type TokenPurpose = "confirm" | "unsubscribe" | "forward-stop";

function secret(): string {
  const value = process.env.BETTER_AUTH_SECRET;
  if (!value) throw new Error("BETTER_AUTH_SECRET isn't set.");
  return value;
}

function digest(membershipId: string, purpose: TokenPurpose): string {
  return createHmac("sha256", secret()).update(`${membershipId}.${purpose}`).digest("base64url");
}

/** `<membershipId>.<signature>`. The membership id is already URL-safe (see lib/ids.ts). */
export function signSubjectToken(membershipId: string, purpose: TokenPurpose): string {
  return `${membershipId}.${digest(membershipId, purpose)}`;
}

/** Verifies a token for the given purpose and returns the membership id it names, or null. */
export function verifySubjectToken(token: string, purpose: TokenPurpose): string | null {
  const at = token.lastIndexOf(".");
  if (at <= 0 || at === token.length - 1) return null;
  const membershipId = token.slice(0, at);
  const signature = token.slice(at + 1);

  const expected = Buffer.from(digest(membershipId, purpose), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  return membershipId;
}
