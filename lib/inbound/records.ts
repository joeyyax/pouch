import type { domains } from "@/lib/db/schema";
import type { Adapter } from "@/lib/providers/adapters/types";
import { INBOUND_SUBDOMAIN_DEFAULT } from "./constants";

/**
 * The host inbound mail lands on — never the domain's own apex, so its existing mailbox (and its
 * own send verification) is untouched by opting in to inbound.
 */
export function inboundHost(domain: string, subdomain: string = INBOUND_SUBDOMAIN_DEFAULT): string {
  return `${subdomain}.${domain}`;
}

/** Takes down the provider's routing for a domain's inbound mail. A provider that routes nothing through its API has nothing to take down. */
export async function closeInboundRoute(domain: typeof domains.$inferSelect, client: Adapter): Promise<void> {
  if (!client.inbound?.close) return;
  await client.inbound.close({ domainId: domain.id, host: inboundHost(domain.name, domain.inboundSubdomain) }, domain.inboundProviderSettings);
}
