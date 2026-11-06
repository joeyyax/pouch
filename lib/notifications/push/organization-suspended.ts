import { sendPushAlert } from "@/lib/notifications/push/push";

const SOURCE_LABEL = { manual: "by an admin", reputation: "by the reputation guard", provider: "by the provider" } as const;

/** Push alert for an organization that just stopped sending. Call only from the write that suspended it. */
export async function sendOrganizationSuspendedAlert(
  organizationName: string,
  input: { source: keyof typeof SOURCE_LABEL; reason: string },
): Promise<void> {
  await sendPushAlert({
    title: `Organization suspended: ${organizationName}`,
    message: `Suspended ${SOURCE_LABEL[input.source]}. ${input.reason}`,
    tags: ["warning", "email"],
    priority: 4,
  });
}
