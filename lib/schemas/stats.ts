import { z } from "zod";
import { defineShape, shapeQuery } from "@/lib/api/shape";
import { statusList } from "./message";

export const STATS_WINDOWS = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 } as const;
export type StatsWindow = keyof typeof STATS_WINDOWS;

/** The longest `since` to `until` a read takes. */
export const MAX_STATS_DAYS = 90;

const STATS_KEYS = [
  "window",
  "mode",
  "counts",
  "previous_counts",
  "attempts",
  "buckets",
  "previous_buckets",
  "latency",
  "domains",
  "keys",
  "reasons",
  "queue",
  "inbound",
  "domain_days",
] as const;

/** `GET /v1/stats`. `window` names the read, so it always comes back. */
export const statsShape = defineShape({
  resource: "stats",
  idKey: "window",
  keys: STATS_KEYS,
  defaults: ["window", "mode", "counts", "previous_counts", "attempts", "buckets"],
  expansions: {
    previous_buckets: { keys: ["previous_buckets"], description: "the previous window's buckets, aligned with buckets by index" },
    latency: { keys: ["latency"], description: "p50, p95 and p99 of time in the queue, at the provider and end to end" },
    domains: { keys: ["domains"], description: "counts, queue p95, last send and bucket totals per domain" },
    keys: { keys: ["keys"], description: "counts and bucket totals per key" },
    reasons: { keys: ["reasons"], description: "the receiving servers' words for bounces and complaints, most common first" },
    queue: { keys: ["queue"], description: "what's queued right now: due, backing off, held, in progress and silent, with the oldest of each" },
    inbound: { keys: ["inbound"], description: "mail received, in total and per bucket. Not for test keys" },
    domain_days: {
      keys: ["domain_days"],
      description: "each domain's daily rollup: delivery-time quantiles over the 7 days before and sends by UTC hour over the 28 days before",
    },
  },
});

const windowNames = Object.keys(STATS_WINDOWS) as [StatsWindow, ...StatsWindow[]];

/** The query's fields before the checks across them, for the MCP tool to extend. */
export const statsQueryFields = z.object({
  window: z.enum(windowNames).optional().describe("A window ending now: 24h, 7d, 30d or 90d. Defaults to 30d. Leave out with since and until."),
  since: z.coerce.date().optional().describe("Start of a window, ISO 8601, in place of window. Inclusive."),
  until: z.coerce.date().optional().describe("End of a window, ISO 8601. Exclusive. Defaults to now."),
  bucket: z.enum(["hour", "day"]).optional().describe("UTC hours or UTC days. Defaults to hour for a window of a day or less, day otherwise."),
  mode: z
    .enum(["live", "test", "all"])
    .optional()
    .describe("Which mail to count: live (the default for a live key), test or all. A test key counts test mail only."),
  domain: z.string().optional().describe("Only this domain id."),
  key: z.string().optional().describe("Only messages sent with this key id."),
  status: statusList,
  ...shapeQuery(statsShape),
});

export const readStatsSchema = statsQueryFields.superRefine((query, ctx) => {
  if (query.window && (query.since || query.until)) {
    ctx.addIssue({ code: "custom", path: ["window"], message: "Send window, or since and until, not both." });
  }
  if (query.until && !query.since) {
    ctx.addIssue({ code: "custom", path: ["since"], message: "until needs since." });
  }
  if (query.since && query.until && query.until <= query.since) {
    ctx.addIssue({ code: "custom", path: ["until"], message: "until must be after since." });
  }
  const end = query.until ?? new Date();
  if (query.since && end.getTime() - query.since.getTime() > MAX_STATS_DAYS * 86_400_000) {
    ctx.addIssue({ code: "custom", path: ["since"], message: `A window can cover ${MAX_STATS_DAYS} days at most.` });
  }
});

export type ReadStatsQuery = z.infer<typeof readStatsSchema>;
