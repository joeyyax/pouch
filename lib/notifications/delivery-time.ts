/** Emails owners when a domain's delivery time finding opens, once until it closes. */
import { baseUrl } from "@/lib/api/urls";
import type { DomainStanding } from "@/lib/reputation/read";
import { sendNotification } from "./send";
import { clearNotifications } from "./throttle";

/** One pass over the organization's domains, read for standing. Returns how many mails went out. */
export async function notifyDeliveryTime(organizationId: string, domains: Iterable<DomainStanding>, now: Date): Promise<number> {
  const holding: string[] = [];
  let emailed = 0;
  for (const domain of domains) {
    const finding = domain.findings.find((candidate) => candidate.kind === "delivery_time");
    if (!finding) continue;
    holding.push(domain.id);
    const { sent } = await sendNotification({
      type: "delivery_time",
      organizationId,
      input: {
        domainName: domain.name,
        title: finding.title,
        body: finding.body,
        action: finding.action,
        url: `${baseUrl()}/domains/${encodeURIComponent(domain.id)}/reputation`,
      },
      key: `${domain.id}:${now.toISOString()}`,
      about: [domain.id],
      now,
    });
    if (sent > 0) emailed += 1;
  }
  await clearNotifications(organizationId, "delivery_time", holding, now);
  return emailed;
}
