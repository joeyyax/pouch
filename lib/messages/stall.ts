import { describeStall, type StallDetail, type StallReason } from "@/lib/domains/guard";
import { stallStateFor, type DomainStallState } from "@/lib/domains/stall";
import type { MessageRow } from "@/lib/db/schema";
import { holdsQueue, suspensionOf, type OrganizationSuspension } from "@/lib/suspension";
import type { OrganizationStallState } from "./serialize";

/** The stall guard's own verdict, spread into `organizations.suspend_detail` by `checkOrganizationStall`. */
function reputationStallDetail(detail: Record<string, unknown> | null): { reason: StallReason; detail: StallDetail } | null {
  if (!detail || typeof detail.reason !== "string" || typeof detail.metric !== "string" || typeof detail.count !== "number") {
    return null;
  }
  const { reason, ...rest } = detail;
  return { reason: reason as StallReason, detail: rest as unknown as StallDetail };
}

function organizationHold(suspension: OrganizationSuspension): OrganizationStallState | null {
  if (suspension.source === "provider") {
    return { stalledAt: suspension.suspendedAt, reason: "provider_paused", message: suspension.reason };
  }
  const verdict = reputationStallDetail(suspension.detail);
  return verdict
    ? { stalledAt: suspension.suspendedAt, reason: verdict.reason, message: describeStall(verdict.reason, verdict.detail) }
    : null;
}

/** What holds a message, as `serializeMessage` takes it. Only a queued message can be held. */
export async function messageHold(
  message: Pick<MessageRow, "status" | "domainId" | "organizationId">,
): Promise<{ domainStall: DomainStallState | null; organizationStall: OrganizationStallState | null }> {
  if (message.status !== "queued") return { domainStall: null, organizationStall: null };

  const domainStall = (await stallStateFor([message.domainId])).get(message.domainId) ?? null;
  if (domainStall) return { domainStall, organizationStall: null };

  // The service's own mail isn't shown to an organization, so it has no organization hold to explain.
  if (message.organizationId === null) return { domainStall: null, organizationStall: null };
  const suspension = await suspensionOf(message.organizationId);
  if (!suspension || !holdsQueue(suspension.source)) return { domainStall: null, organizationStall: null };
  return { domainStall: null, organizationStall: organizationHold(suspension) };
}
