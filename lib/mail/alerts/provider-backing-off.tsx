import type { ProviderRow } from "@/lib/providers";
import { sendSystemAlert } from "@/lib/mail/system";
import { SystemMail, type SystemMailBody } from "@/lib/mail/template";
import { organizationName } from "./names";

/**
 * One state change, one alert: keyed on the provider and the moment its current, unbroken
 * backoff run started. `backingOffSince` only moves when the provider sends successfully and
 * then backs off again, so a worker restarting mid-run replays the same message instead of
 * sending a second one.
 */
function idempotencyKey(provider: ProviderRow, since: Date): string {
  return `provider-backing-off:${provider.id}:${since.toISOString()}`;
}

/** The alert's body; the footer is added per recipient. */
export function providerBackingOffMail(provider: ProviderRow, since: Date, windowMs: number, organization: string | null): Omit<SystemMailBody, "reason"> {
  const minutes = Math.round(windowMs / 60_000);
  return {
    heading: `${provider.name} has been backing off for over ${minutes} minutes`,
    paragraphs: [
      `The provider hasn't sent anything successfully since it started backing off. Nothing has failed outright, but mail is waiting.`,
      "Check the provider's own dashboard for what's throttling it.",
    ],
    facts: [
      ["Provider", `${provider.name} (${provider.adapter})`],
      ["Organization", organization ?? "Shared"],
      ["Backing off since", `${since.toISOString().replace("T", " ").slice(0, 16)} UTC`],
    ],
  };
}

export function ProviderBackingOffEmail({ provider, since, windowMs, organization, reason }: { provider: ProviderRow; since: Date; windowMs: number; organization: string | null; reason: string }) {
  return <SystemMail {...providerBackingOffMail(provider, since, windowMs, organization)} reason={reason} />;
}

/** Sends the alert for a provider that's been backing off, without a successful send, longer than the window. `since` is `provider.backingOffSince`. */
export async function sendProviderBackingOffAlert(provider: ProviderRow, since: Date, windowMs: number): Promise<void> {
  const organization = provider.organizationId ? await organizationName(provider.organizationId) : null;
  await sendSystemAlert({
    subject: `Provider backing off: ${provider.name}`,
    email: (reason) => <ProviderBackingOffEmail provider={provider} since={since} windowMs={windowMs} organization={organization} reason={reason} />,
    idempotencyKey: idempotencyKey(provider, since),
  });
}
