/**
 * Link-domain checks at send. Bounded in time and failing open: a slow resolver or a spent budget
 * leaves the message unchecked, never held.
 */
import type { LinkListing } from "@/lib/db/schema";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { queryList } from "./check";
import { BLOCKLISTS, normalizeDomain, type BlocklistId } from "./lists";
import { dqsKey, markKeyProblem, readKeyProblem } from "./status";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("blocklists:links");

/** The whole check for one message, cache reads included. */
export const LINK_CHECK_TIMEOUT_MS = 500;
/** Distinct hosts checked per message. */
export const MAX_LINK_HOSTS = 10;
export const LINK_CACHE_SECONDS = 60 * 60;
/** A failed lookup is retried after this, so a flaky resolver doesn't spend the budget. */
const ERROR_CACHE_SECONDS = 5 * 60;

const CLEAR = "clear";
const ERROR = "error";

/** Distinct link hosts in the html, minus the sender's own domain and the app's. */
export function extractLinkHosts(html: string, exclude: string[]): string[] {
  const skip = exclude.map((domain) => domain.toLowerCase());
  const hosts = new Set<string>();
  for (const match of html.matchAll(/\bhref\s*=\s*["']?\s*(https?:\/\/[^"'\s>]+)/gi)) {
    let host: string;
    try {
      host = new URL(match[1]!.replaceAll("&amp;", "&")).hostname;
    } catch {
      continue;
    }
    const name = normalizeDomain(host);
    if (!name || skip.some((domain) => name === domain || name.endsWith(`.${domain}`))) continue;
    hosts.add(name);
    if (hosts.size >= MAX_LINK_HOSTS) break;
  }
  return [...hosts];
}

function appHost(): string | null {
  try {
    return process.env.APP_URL ? new URL(process.env.APP_URL).hostname : null;
  } catch {
    return null;
  }
}

function cacheKey(list: BlocklistId, host: string): string {
  return `blocklists:link:${list}:${host}`;
}

async function checkHost(list: BlocklistId, host: string, now: Date, timeoutMs: number): Promise<LinkListing | null> {
  const client = redis();
  if (!client) return null;
  const cached = await client.get(cacheKey(list, host));
  if (cached === CLEAR || cached === ERROR) return null;
  if (cached) return JSON.parse(cached) as LinkListing;

  const outcome = await queryList(list, host, "links", now, timeoutMs);
  if (outcome.kind === "skipped") return null;
  if (outcome.kind === "error") {
    if (outcome.error === "refused" || outcome.error === "key_invalid" || outcome.error === "rate_limited") {
      await markKeyProblem(outcome.error, outcome.code ?? null, now);
    }
    await client.set(cacheKey(list, host), ERROR, "EX", ERROR_CACHE_SECONDS);
    return null;
  }
  if (outcome.kind === "clear") {
    await client.set(cacheKey(list, host), CLEAR, "EX", LINK_CACHE_SECONDS);
    return null;
  }
  const listing: LinkListing = { domain: host, list, code: outcome.code, reason: outcome.reason };
  await client.set(cacheKey(list, host), JSON.stringify(listing), "EX", LINK_CACHE_SECONDS);
  return listing;
}

async function run(html: string, sendingDomain: string, now: Date, timeoutMs: number): Promise<LinkListing[] | null> {
  if (!dqsKey() || !redis()) return null;
  const hosts = extractLinkHosts(html, [sendingDomain, ...(appHost() ? [appHost()!] : [])]);
  if (hosts.length === 0) return null;
  if (await readKeyProblem()) return null;
  const results = await Promise.all(hosts.flatMap((host) => BLOCKLISTS.map((list) => checkHost(list, host, now, timeoutMs))));
  const listed = results.filter((result): result is LinkListing => result !== null);
  return listed.length > 0 ? listed : null;
}

/**
 * The listed link domains in `html`, or null. Resolves within `timeoutMs` and never rejects;
 * anything unfinished by then counts as unchecked.
 */
export async function checkLinkDomains(
  html: string | null | undefined,
  sendingDomain: string,
  now: Date,
  timeoutMs = LINK_CHECK_TIMEOUT_MS,
): Promise<LinkListing[] | null> {
  if (!html) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const work = run(html, sendingDomain, now, timeoutMs).catch((err: unknown) => {
    log.warn(`link check failed: ${safeErrorMessage(err)}`);
    return null;
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
