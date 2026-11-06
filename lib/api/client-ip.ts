import { createHmac } from "node:crypto";

const LOCAL = "unknown";

/**
 * The client address, for buckets that have to work before a key is known.
 * Traefik appends the peer to `x-forwarded-for`, so the last entry is the one hop we set
 * ourselves; earlier entries are whatever the caller sent and can't be trusted.
 */
export function clientIp(request: Pick<Request, "headers">): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
    const peer = hops.at(-1);
    if (peer) return peer;
  }
  return request.headers.get("x-real-ip")?.trim() || LOCAL;
}

/** A keyed hash of an address: 128 bits of HMAC-SHA256 under `BETTER_AUTH_SECRET`, so neither Redis nor the activity log holds the IP. */
export function hashIp(ip: string): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET isn't set.");
  return createHmac("sha256", secret).update(ip).digest("base64url").slice(0, 22);
}

/** The client address as a rate-limit bucket. */
export function clientIpBucket(request: Pick<Request, "headers">): string {
  return hashIp(clientIp(request));
}

/** The hashed address and user agent for an activity row. A request that names no address stores none. */
export function clientOf(request: Pick<Request, "headers">): { ipHash: string | null; userAgent: string | null } {
  const ip = clientIp(request);
  return { ipHash: ip === LOCAL ? null : hashIp(ip), userAgent: request.headers.get("user-agent") };
}
