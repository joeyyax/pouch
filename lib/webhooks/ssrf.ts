import { lookup as dnsLookup } from "node:dns/promises";

export class UnsafeWebhookUrlError extends Error {}

/**
 * The host couldn't be resolved. A subclass so registration still rejects on it, while delivery
 * can tell it apart: a receiver's DNS being down for a minute is a transport failure that belongs
 * in the retry schedule, not a URL that's unsafe to try.
 */
export class WebhookHostUnresolvedError extends UnsafeWebhookUrlError {}

export interface ResolvedTarget {
  hostname: string;
  port: number;
  protocol: "http:" | "https:";
  /** Path plus query string, exactly as given. */
  path: string;
  /** The literal address to connect to. Resolved and validated together, so a DNS answer that
   * changes between the check and the request can't smuggle a private address past the guard. */
  address: string;
  family: 4 | 6;
}

/** 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 0/8, 100.64/10 (CGNAT), 198.18/15, 224/4, 255.255.255.255. */
function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  const [a, b] = parts;
  if (parts.length !== 4 || a === undefined || b === undefined) return true;
  if (parts.some((part) => Number.isNaN(part))) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && b >= 18 && b <= 19) return true;
  if (a >= 224) return true;
  return false;
}

/** ::1 (loopback), fe80::/10 (link-local), fc00::/7 (unique-local), ::ffff:0:0/96 (mapped v4, both spellings). */
function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fe80:") || normalized.startsWith("fe8") || normalized.startsWith("fe9")) return true;
  if (normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  // The same address in hex, which Node's resolver can return: ::ffff:7f00:1 is 127.0.0.1.
  const hex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = parseInt(hex[1]!, 16);
    const low = parseInt(hex[2]!, 16);
    return isPrivateIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff].join("."));
  }
  return false;
}

export function isPrivateAddress(address: string, family: 4 | 6): boolean {
  return family === 4 ? isPrivateIpv4(address) : isPrivateIpv6(address);
}

/**
 * Resolves a webhook URL's host and rejects private, loopback, link-local and unique-local
 * addresses. Called at registration and again immediately before every delivery attempt —
 * checking only once would let a hostname resolve safely at registration and then rebind to a
 * private address by the time the worker connects.
 */
export async function resolvePublicTarget(rawUrl: string): Promise<ResolvedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeWebhookUrlError("That URL isn't valid.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeWebhookUrlError("Webhook URLs must be http or https.");
  }

  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;

  let addresses: { address: string; family: number }[];
  try {
    addresses = await dnsLookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new WebhookHostUnresolvedError("That host doesn't resolve.");
  }
  if (addresses.length === 0) throw new WebhookHostUnresolvedError("That host doesn't resolve.");

  const resolved = addresses.map((entry) => ({
    address: entry.address,
    family: (entry.family === 6 ? 6 : 4) as 4 | 6,
  }));

  // The one documented exception: http to loopback, in development, for a local receiver. Every
  // other case — including https to loopback — falls through to the private-address rejection.
  const allLoopback = resolved.every((entry) => isLoopback(entry.address, entry.family));
  const isDevLoopbackHttp = url.protocol === "http:" && allLoopback && process.env.NODE_ENV !== "production";

  if (!isDevLoopbackHttp) {
    if (url.protocol === "http:") {
      throw new UnsafeWebhookUrlError("Webhook URLs must be https, except loopback in development.");
    }
    const unsafe = resolved.find((entry) => isPrivateAddress(entry.address, entry.family));
    if (unsafe) {
      throw new UnsafeWebhookUrlError(`${url.hostname} resolves to a private address and can't be used.`);
    }
  }

  const chosen = resolved[0]!;
  return {
    hostname: url.hostname,
    port,
    protocol: url.protocol as "http:" | "https:",
    path: `${url.pathname}${url.search}`,
    address: chosen.address,
    family: chosen.family,
  };
}

function isLoopback(address: string, family: 4 | 6): boolean {
  if (family === 4) return address.split(".")[0] === "127";
  return address.toLowerCase() === "::1";
}
