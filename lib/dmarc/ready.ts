/** Emails owners once when a domain is ready for `p=quarantine`, and re-arms once its policy moves on. */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { dmarcDomainTokens, domains } from "@/lib/db/schema";
import { recordActivity, workerActor } from "@/lib/activity/record";
import { baseUrl } from "@/lib/api/urls";
import { logger } from "@/lib/logger";
import { sendNotification } from "@/lib/notifications/send";
import { readOwnPolicy, readQuarantineRecommendation } from "./read";
import { dmarcOnFor } from "./switch";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("dmarc:ready");

/** One pass over the organization's domains with a report address. Returns how many were emailed. */
export async function checkDmarcPolicyReady(organizationId: string, now: Date): Promise<number> {
  if (!(await dmarcOnFor(organizationId))) return 0;
  const rows = await db
    .select({ id: domains.id, name: domains.name, notifiedAt: dmarcDomainTokens.policyReadyNotifiedAt })
    .from(dmarcDomainTokens)
    .innerJoin(domains, eq(domains.id, dmarcDomainTokens.domainId))
    .where(eq(dmarcDomainTokens.organizationId, organizationId));

  let emailed = 0;
  for (const domain of rows) {
    try {
      if (domain.notifiedAt) await rearm(domain);
      else if (await notify(organizationId, domain, now)) emailed += 1;
    } catch (err) {
      log.warn(`checking ${domain.name} threw: ${safeErrorMessage(err)}`);
    }
  }
  return emailed;
}

/** Clears the send once the published policy is past none, so a return to none can qualify again. */
async function rearm(domain: { id: string; name: string }): Promise<void> {
  const own = await readOwnPolicy(domain.name);
  if (!own || own.policy === "none") return;
  await db.update(dmarcDomainTokens).set({ policyReadyNotifiedAt: null }).where(eq(dmarcDomainTokens.domainId, domain.id));
}

async function notify(organizationId: string, domain: { id: string; name: string }, now: Date): Promise<boolean> {
  const recommendation = await readQuarantineRecommendation(organizationId, domain, now);
  if (!recommendation) return false;

  const claimed = await db
    .update(dmarcDomainTokens)
    .set({ policyReadyNotifiedAt: now })
    .where(and(eq(dmarcDomainTokens.domainId, domain.id), isNull(dmarcDomainTokens.policyReadyNotifiedAt)))
    .returning({ id: dmarcDomainTokens.domainId });
  if (claimed.length === 0) return false;

  const input = {
    domainName: domain.name,
    days: recommendation.days,
    record: { name: recommendation.name, value: recommendation.value },
    url: `${baseUrl()}/domains/${encodeURIComponent(domain.id)}/reputation`,
  };
  const { sent, skipped } = await sendNotification({
    type: "dmarc_policy_ready",
    organizationId,
    input,
    key: `${domain.id}:${now.toISOString()}`,
    appliesTo: domain.id,
  });
  if (sent === 0) {
    // Silenced by the operator or every owner counts as handled; a send that reached nobody tries again.
    if (skipped === null) await db.update(dmarcDomainTokens).set({ policyReadyNotifiedAt: null }).where(eq(dmarcDomainTokens.domainId, domain.id));
    return false;
  }

  await recordActivity({
    organizationId,
    action: "domain.dmarc_policy.recommended",
    actor: workerActor("DMARC reports"),
    appliesTo: domain.id,
    subjectLabel: domain.name,
    metadata: { policy: "quarantine", days: recommendation.days, record: recommendation.value, owners: sent },
  });
  return true;
}
