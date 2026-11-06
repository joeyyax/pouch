/** The organization's standing as `GET /v1/reputation` returns it. */
import { ApiError } from "@/lib/api/errors";
import { dbNow } from "@/lib/db/clock";
import { readOrganizationReputation } from "./read";
import { standingReason, type Finding, type Standing } from "./standing";

export interface SerializedReputation {
  object: "reputation";
  subject: { type: "organization"; id: string; name: string };
  standing: Standing;
  reason: string | null;
  findings: Pick<Finding, "kind" | "standing" | "title" | "body" | "action">[];
  /** Domains that aren't healthy, worst first. */
  domains: { id: string; name: string; standing: Standing }[];
}

export async function readReputation(caller: { organizationId: string; domainIds: string[] }): Promise<SerializedReputation> {
  // Same rule as the organization webhook: it summarizes every domain.
  if (caller.domainIds.length > 0) {
    throw new ApiError("key_not_scoped", "This key is scoped to specific domains and can't read the organization's standing.");
  }
  const reputation = await readOrganizationReputation(caller.organizationId, await dbNow());
  return {
    object: "reputation",
    subject: { type: "organization", id: caller.organizationId, name: reputation.name },
    standing: reputation.standing,
    reason: standingReason(reputation),
    findings: reputation.findings.map(({ kind, standing, title, body, action }) => ({ kind, standing, title, body, action })),
    domains: reputation.attention,
  };
}
