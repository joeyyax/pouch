/** The private bucket's lifecycle rules for message bodies and inbound mail, read from the bucket itself. */
import { GetBucketLifecycleConfigurationCommand, type LifecycleRule } from "@aws-sdk/client-s3";
import { ApiError } from "@/lib/api/errors";
import { brand } from "@/lib/brand";
import { safeErrorMessage } from "@/lib/errors/scrub";
import { inboundRoot } from "@/lib/inbound/attachments";
import { logger } from "@/lib/logger";
import { bodiesRoot } from "./bodies";
import { storage, storageBucket } from "./index";

const log = logger.child("storage:lifecycle");

/** `rule`: the fewest days any enabled rule takes to expire an object under the root. `none`: no rule does. `unreadable`: the bucket wouldn't say. */
export type BodyLifecycle = { state: "rule"; days: number } | { state: "none" } | { state: "unreadable" };

const CACHE_MS = 60_000;
let cached: { at: number; rules: LifecycleRule[] | null } | null = null;

/** Days after which a rule expires some objects under the root, or null when it never does. A tag filter never matches: nothing Pouch writes carries tags. */
function expiryDays(rule: LifecycleRule, root: string): number | null {
  const days = rule.Expiration?.Days;
  if (rule.Status !== "Enabled" || !days) return null;
  if (rule.Filter?.Tag || rule.Filter?.And?.Tags?.length) return null;
  const prefix = rule.Filter?.Prefix ?? rule.Filter?.And?.Prefix ?? rule.Prefix ?? "";
  const folder = `${root}/`;
  return folder.startsWith(prefix) || prefix.startsWith(folder) ? days : null;
}

/** The fewest expiry days across rules that reach objects under the root, or null. */
export function bodyExpiryDays(rules: LifecycleRule[], root = bodiesRoot()): number | null {
  const days = rules.map((rule) => expiryDays(rule, root)).filter((value): value is number => value !== null);
  return days.length > 0 ? Math.min(...days) : null;
}

/** The bucket's rules, read at most once a minute per process. Null when the bucket won't say. */
async function readRules(): Promise<LifecycleRule[] | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.rules;
  let rules: LifecycleRule[] | null;
  try {
    const result = await storage().send(new GetBucketLifecycleConfigurationCommand({ Bucket: storageBucket() }));
    rules = result.Rules ?? [];
  } catch (error) {
    if ((error as { name?: string }).name === "NoSuchLifecycleConfiguration") {
      rules = [];
    } else {
      log.warn(`couldn't read the bucket's lifecycle rule: ${safeErrorMessage(error)}`);
      rules = null;
    }
  }
  cached = { at: Date.now(), rules };
  return rules;
}

async function lifecycleUnder(root: string): Promise<BodyLifecycle> {
  const rules = await readRules();
  if (rules === null) return { state: "unreadable" };
  const days = bodyExpiryDays(rules, root);
  return days === null ? { state: "none" } : { state: "rule", days };
}

/** The rule for message bodies. */
export function readBodyLifecycle(): Promise<BodyLifecycle> {
  return lifecycleUnder(bodiesRoot());
}

/** The rule for inbound mail's objects. None is fine: the inbound sweep deletes them itself. */
export function readInboundLifecycle(): Promise<BodyLifecycle> {
  return lifecycleUnder(inboundRoot());
}

export function resetBodyLifecycleCache(): void {
  cached = null;
}

/** Refuses a retention ceiling the bucket would undercut: its rule would delete bodies whose keys still exist. */
export async function assertCeilingBelowBucketRule(ceiling: number): Promise<void> {
  const lifecycle = await readBodyLifecycle();
  if (lifecycle.state !== "rule" || ceiling < lifecycle.days) return;
  throw new ApiError(
    "validation_failed",
    `The bucket's lifecycle rule expires bodies after ${lifecycle.days} days, so the ceiling has to be under ${lifecycle.days}. Move the rule past ${ceiling} days first.`,
    { field: "body_retention_max_days", detail: { bucket_expiry_days: lifecycle.days } },
  );
}

/** Refuses an inbound ceiling the bucket would undercut: its rule would delete mail the API still lists. */
export async function assertInboundCeilingBelowBucketRule(ceiling: number): Promise<void> {
  const lifecycle = await readInboundLifecycle();
  if (lifecycle.state !== "rule" || ceiling < lifecycle.days) return;
  throw new ApiError(
    "validation_failed",
    `The bucket's lifecycle rule expires inbound mail after ${lifecycle.days} days, so the ceiling has to be under ${lifecycle.days}. Move the rule past ${ceiling} days first.`,
    { field: "inbound_retention_max_days", detail: { bucket_expiry_days: lifecycle.days } },
  );
}

/** What admin shows beside the ceiling. */
export function describeBodyLifecycle(lifecycle: BodyLifecycle, ceiling: number): { text: string; warning: boolean } {
  if (lifecycle.state === "unreadable") {
    return { text: `${brand.name} can't read the bucket's lifecycle rule. Make sure it expires bodies after more than ${ceiling} days.`, warning: true };
  }
  if (lifecycle.state === "none") return { text: "No lifecycle rule on the bucket expires bodies, so their objects stay after their keys go.", warning: true };
  if (ceiling >= lifecycle.days) {
    return {
      text: `The bucket's lifecycle rule expires bodies after ${lifecycle.days} days, at or under this ceiling, so bodies can go before their keys do.`,
      warning: true,
    };
  }
  return { text: `The bucket's lifecycle rule expires bodies after ${lifecycle.days} days.`, warning: false };
}

/** What admin shows beside the inbound ceiling. Nothing when no rule reaches inbound mail. */
export function describeInboundLifecycle(lifecycle: BodyLifecycle, ceiling: number): { text: string; warning: boolean } | null {
  if (lifecycle.state === "unreadable") {
    return { text: `${brand.name} can't read the bucket's lifecycle rule. Make sure none expires inbound mail within ${ceiling} days.`, warning: true };
  }
  if (lifecycle.state === "none") return null;
  if (ceiling >= lifecycle.days) {
    return {
      text: `The bucket's lifecycle rule expires inbound mail after ${lifecycle.days} days, at or under this ceiling, so mail can go before its retention ends.`,
      warning: true,
    };
  }
  return { text: `The bucket's lifecycle rule expires inbound mail after ${lifecycle.days} days.`, warning: false };
}

/** Degraded when no rule collects bodies or one expires them at or under the ceiling. Unknown when the bucket won't say. */
export function bodyLifecycleStatus(lifecycle: BodyLifecycle, ceiling: number): "ok" | "degraded" | "unknown" {
  if (lifecycle.state === "unreadable") return "unknown";
  if (lifecycle.state === "none" || lifecycle.days <= ceiling) return "degraded";
  return "ok";
}

/** Degraded when a rule expires inbound mail at or under its ceiling. No rule is fine. */
export function inboundLifecycleStatus(lifecycle: BodyLifecycle, ceiling: number): "ok" | "degraded" | "unknown" {
  if (lifecycle.state === "unreadable") return "unknown";
  if (lifecycle.state === "rule" && lifecycle.days <= ceiling) return "degraded";
  return "ok";
}
