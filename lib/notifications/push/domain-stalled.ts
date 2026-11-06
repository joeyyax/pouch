import type { domains } from "@/lib/db/schema";
import { describeStall, type StallVerdict } from "@/lib/domains/guard";
import { sendPushAlert } from "@/lib/notifications/push/push";

type DomainRow = typeof domains.$inferSelect;

/**
 * Push alert for a domain that just entered the stalled state — mail has stopped going out and
 * nobody's looking at the dashboard. Never email: the queue that would send it is the thing
 * that stopped. Call only from the write that actually flips the domain to stalled (see
 * lib/domains/stall.ts's stallDomain), so a worker restart mid-stall can't call this twice.
 */
export async function sendDomainStalledAlert(domain: DomainRow, verdict: StallVerdict): Promise<void> {
  await sendPushAlert({
    title: `Domain paused: ${domain.name}`,
    message: describeStall(verdict.reason, verdict.detail),
    tags: ["warning", "email"],
    priority: 4,
  });
}
