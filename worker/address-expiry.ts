import { and, eq, inArray, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { addresses } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { IntervalLoop } from "@/lib/worker/interval-loop";

const log = logger.child("worker:address-expiry");

export interface AddressExpiryLoopOptions {
  workerId?: string;
  intervalMs: number;
  batchSize: number;
}

/** Marks addresses past their expiry `expired`. Routing reads `expires_at` itself, so a late sweep delivers nothing. */
export class AddressExpiryLoop extends IntervalLoop<{ expired: number }> {
  protected readonly name = "address-expiry";
  protected readonly feature = "addresses" as const;
  protected readonly log = log;
  protected readonly intervalMs: number;
  protected readonly workerId: string | undefined;

  constructor(private readonly options: AddressExpiryLoopOptions) {
    super();
    this.intervalMs = options.intervalMs;
    this.workerId = options.workerId;
  }

  protected async run(): Promise<{ expired: number }> {
    const now = await dbNow();
    let expired = 0;

    for (;;) {
      if (this.stopped) break;
      const due = await db
        .select({ id: addresses.id })
        .from(addresses)
        .where(and(eq(addresses.status, "active"), lte(addresses.expiresAt, now)))
        .limit(this.options.batchSize);
      if (due.length === 0) break;

      // Re-checked in the update: an extend landing between the read and here keeps its address active.
      const updated = await db
        .update(addresses)
        .set({ status: "expired", updatedAt: now })
        .where(and(inArray(addresses.id, due.map((row) => row.id)), eq(addresses.status, "active"), lte(addresses.expiresAt, now)))
        .returning({ id: addresses.id });
      expired += updated.length;
      if (due.length < this.options.batchSize) break;
    }

    if (expired > 0) log.info(`marked ${expired} address(es) expired`);
    return { expired };
  }
}
