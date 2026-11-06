import type { AdapterCapabilities, SetupStep, WebhookTarget } from "./types";

/**
 * The steps a domain still needs done by hand, derived from what the adapter's API can't do.
 * Messages stay provider-blind: the caller learns what's left, not who the provider is.
 */
export function stepsFor(
  capabilities: AdapterCapabilities,
  context: WebhookTarget,
  eventsConfigured = true,
): SetupStep[] {
  const steps: SetupStep[] = [];

  if (!capabilities.domainsViaApi) {
    steps.push({ step: "domain", message: "Add this domain in the provider's dashboard." });
  }
  if (!capabilities.dnsRecordsViaApi) {
    steps.push({ step: "dns_records", message: "Copy the DNS records from the provider's dashboard and publish them." });
  }
  if (!capabilities.webhooksViaApi) {
    steps.push({ step: "webhooks", message: `Register this webhook in the provider's dashboard: ${context.webhookUrl}` });
  } else if (!eventsConfigured) {
    // The adapter can wire its own events but hasn't finished. Verifying the domain runs it again.
    steps.push({ step: "webhooks", message: "Event delivery isn't set up yet. Verify this domain to finish it." });
  }
  if (!capabilities.credentialsWithoutConsole) {
    steps.push({ step: "credentials", message: "Create a sending credential in the provider's dashboard and store it on this account." });
  }
  if (!capabilities.removalViaApi) {
    steps.push({ step: "removal", message: "Deleting this domain here won't remove it from the provider. Remove it in the provider's dashboard too." });
  }

  return steps;
}
