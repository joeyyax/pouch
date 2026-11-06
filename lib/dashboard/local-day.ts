import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { isTimeZone } from "@/lib/time-zone";

/**
 * `YYYY-MM-DD` of a timestamp in `zone`, for grouping by day. A string, not a timestamp, so the
 * driver can't read it back in the process's zone. The zone is inlined rather than bound so the
 * select and the `group by` render the same expression; `isTimeZone` is what makes that safe.
 */
export function localDay(column: AnyColumn | SQL, zone: string): SQL<string> {
  if (!isTimeZone(zone)) throw new Error(`Unknown time zone "${zone}".`);
  return sql<string>`to_char(${column} at time zone ${sql.raw(`'${zone}'`)}, 'YYYY-MM-DD')`;
}

/** `localDay`, or `YYYY-MM-DD HH` in `zone` for hourly buckets. Matches `bucketsIn`'s keys. */
export function localBucket(column: AnyColumn | SQL, zone: string, unit: "hour" | "day"): SQL<string> {
  if (unit === "day") return localDay(column, zone);
  if (!isTimeZone(zone)) throw new Error(`Unknown time zone "${zone}".`);
  return sql<string>`to_char(${column} at time zone ${sql.raw(`'${zone}'`)}, 'YYYY-MM-DD HH24')`;
}
