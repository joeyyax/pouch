import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys, domains } from "@/lib/db/schema";
import { inboundHost } from "@/lib/inbound/records";
import type { AddressCreateOptions } from "@/lib/dashboard/views/addresses";

/** The keys and inbound domains the create form picks from. Every unrevoked organization key, live first. */
export async function loadAddressCreateOptions(organizationId: string): Promise<AddressCreateOptions> {
  const [keys, inbound] = await Promise.all([
    db
      .select({ id: apiKeys.id, name: apiKeys.name, mode: apiKeys.mode, domainIds: apiKeys.domainIds })
      .from(apiKeys)
      .where(and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.scope, "organization"), isNull(apiKeys.revokedAt)))
      .orderBy(asc(apiKeys.mode), asc(apiKeys.name)),
    db
      .select({ id: domains.id, name: domains.name, inboundSubdomain: domains.inboundSubdomain })
      .from(domains)
      .where(and(eq(domains.organizationId, organizationId), eq(domains.inboundEnabled, true)))
      .orderBy(asc(domains.name)),
  ]);
  return {
    keys,
    domains: inbound.map((domain) => ({ id: domain.id, name: domain.name, host: inboundHost(domain.name, domain.inboundSubdomain) })),
  };
}
