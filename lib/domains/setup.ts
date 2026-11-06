/** A domain's setup steps as its organization sees them, on every surface. */
import { ADAPTER_KEYS, capabilitiesOf, setupSteps } from "@/lib/providers/adapters";
import type { SetupStep } from "@/lib/providers/adapters/types";
import { webhookUrl } from "@/lib/webhooks/url";

/** Steps in the provider's console, which only an admin reaches. */
const ADMIN_STEPS: Partial<Record<SetupStep["step"], string>> = {
  domain: "Adding this domain at the provider: waiting on an admin.",
  dns_records: "DNS records from the provider: waiting on an admin.",
  webhooks: "Event delivery: waiting on an admin.",
  credentials: "Sending credential: waiting on an admin.",
  removal: "Deleting this domain here won't remove it from the provider. An admin removes it there.",
};

/** An adapter the registry no longer has reports nothing, rather than failing the read. */
export function domainSetup(adapter: string, providerId: string, eventsConfigured: boolean): SetupStep[] {
  if (!ADAPTER_KEYS.includes(adapter)) return [];
  // An adapter that wires its own events finishes them on the next verify, which the caller can run.
  const selfServeWebhooks = capabilitiesOf(adapter).webhooksViaApi;
  return setupSteps(adapter, { webhookUrl: webhookUrl(adapter, providerId) }, eventsConfigured).map((step) =>
    step.step === "webhooks" && selfServeWebhooks ? step : { ...step, message: ADMIN_STEPS[step.step] ?? step.message },
  );
}
