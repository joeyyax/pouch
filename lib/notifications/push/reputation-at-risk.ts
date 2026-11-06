import { sendPushAlert } from "@/lib/notifications/push/push";
import type { Finding } from "@/lib/reputation/standing";

/** Push alert for a domain or organization that just became at risk. Paused has its own alerts. */
export async function sendReputationAtRiskAlert(subjectName: string, organizationName: string, findings: Finding[]): Promise<void> {
  const first = findings[0];
  await sendPushAlert({
    title: `At risk: ${subjectName}`,
    message: `${organizationName}. ${first ? `${first.title}. ${first.body}` : "Reputation is close to the pause line."}`,
    tags: ["warning", "email"],
    priority: 4,
  });
}
