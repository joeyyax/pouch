import { baseUrl } from "@/lib/api/urls";

/** Where a provider's callbacks land. Provider-scoped, so a receiver knows whose events these are. */
export function webhookUrl(adapter: string, providerId: string): string {
  return `${baseUrl()}/api/webhooks/${adapter}/${providerId}`;
}
