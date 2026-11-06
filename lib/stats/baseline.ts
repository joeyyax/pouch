/** Each domain's last day of volume and the days before it, from the hourly rollup. */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains } from "@/lib/db/schema";
import { ceilHour, HOUR_MS } from "./cells";
import { readCells } from "./read";

const DAY_MS = 24 * HOUR_MS;

export interface DomainVolume {
  domainId: string;
  domainName: string;
  /** Live messages accepted in the 24 hours up to the current hour's end. */
  lastDay: number;
  /** The `days` 24-hour slices before it, newest first, each ending at the same hour of day. */
  baseline: number[];
}

/**
 * Live volume per domain in 24-hour slices ending on the hour after `now`, so the last day and
 * every baseline day cover the same hours of the day. Domains with nothing in the span are left out.
 */
export async function readDomainVolumes(organizationId: string, days: number, now: Date): Promise<DomainVolume[]> {
  const end = ceilHour(new Date(now.getTime() + 1));
  const since = new Date(end.getTime() - (days + 1) * DAY_MS);
  const cells = await readCells({ organizationId, domainIds: [], mode: "live" }, since, now, now);

  const slices = new Map<string, number[]>();
  for (const cell of cells) {
    const index = Math.floor((end.getTime() - cell.hour.getTime() - 1) / DAY_MS);
    if (index < 0 || index > days) continue;
    const row = slices.get(cell.domainId) ?? new Array<number>(days + 1).fill(0);
    row[index]! += cell.total;
    slices.set(cell.domainId, row);
  }
  if (slices.size === 0) return [];

  const rows = await db
    .select({ id: domains.id, name: domains.name })
    .from(domains)
    .where(eq(domains.organizationId, organizationId));
  const names = new Map(rows.map((row) => [row.id, row.name]));
  return [...slices]
    .filter(([domainId]) => names.has(domainId))
    .map(([domainId, [lastDay = 0, ...baseline]]) => ({ domainId, domainName: names.get(domainId)!, lastDay, baseline }));
}
