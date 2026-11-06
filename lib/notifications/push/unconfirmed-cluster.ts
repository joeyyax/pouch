import { baseUrl } from "@/lib/api/urls";
import type { UnconfirmedClusterView } from "@/lib/system/views";
import { UNCONFIRMED_WINDOW_MS } from "@/lib/system/views";
import { spellDuration } from "@/lib/metrics/duration";
import { formatRate } from "@/lib/metrics/rates";
import { sendPushAlert } from "@/lib/notifications/push/push";
import { formatNumber } from "@/lib/format/number";

/**
 * Push alert for unconfirmed marks crossing into clustered. The action is the subscription
 * feeding the heaviest provider's endpoint, never any one message. Call only from the
 * transition (see lib/messages/unconfirmed-alert.ts), so a cluster that lasts pushes once.
 */
export async function sendUnconfirmedClusterAlert(view: UnconfirmedClusterView): Promise<void> {
  const endpoint = view.providers.find((provider) => provider.webhookUrl)?.webhookUrl;
  await sendPushAlert({
    title: "Unconfirmed sends are clustering",
    message: [
      `${formatNumber(view.marked)} messages marked unconfirmed in the last ${spellDuration(UNCONFIRMED_WINDOW_MS)},`,
      `${formatRate(view.share)} of the ${formatNumber(view.eligibleSends)} sends up for marking.`,
      "Delivery events aren't arriving.",
      endpoint ? `Check the subscription posting to ${endpoint}.` : "Check the subscription posting to the provider's webhook endpoint.",
    ].join(" "),
    tags: ["warning", "email"],
    priority: 4,
    click: `${baseUrl()}/admin/settings/system#unconfirmed-sends`,
  });
}
