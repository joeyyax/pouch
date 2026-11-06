import { describeStall, type StallVerdict } from "@/lib/domains/guard";
import { sendPushAlert } from "@/lib/notifications/push/push";

/** Push alert for organizations whose summed rate on one provider identity crossed the action point. */
export async function sendProviderIdentityAtRiskAlert(
  group: { adapter: string; identity: string | null; organizationNames: string[] },
  verdict: StallVerdict,
): Promise<void> {
  await sendPushAlert({
    title: `Provider at risk: ${group.adapter} ${group.identity ?? "unknown identity"}`,
    message: `${describeStall(verdict.reason, verdict.detail)} Shared by ${group.organizationNames.join(", ")}.`,
    tags: ["warning", "email"],
    priority: 4,
  });
}
