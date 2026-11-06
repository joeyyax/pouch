/** Rebuilds provider setup a send found missing. */
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, providers } from "@/lib/db/schema";
import type { ProviderRow } from "@/lib/providers";
import { PROVIDER_CHECK_TTL_SECONDS, TENANT_CHECK_TTL_SECONDS, recordProviderProbe } from "@/lib/health/checks";
import { logger } from "@/lib/logger";
import { sendPushAlert } from "@/lib/notifications/push/push";
import type { LostSetup } from "@/lib/providers/adapters/types";
import { configureEvents } from "./index";
import { brand } from "@/lib/brand";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("domains:rebuild");

/** Marks the provider for rebuilding. True only for the call that marked it. */
async function markLost(providerId: string, lost: LostSetup): Promise<boolean> {
  const marked = await db
    .update(providers)
    .set({ settings: sql`${providers.settings} || ${JSON.stringify(lost.settings)}::jsonb`, updatedAt: new Date() })
    .where(and(eq(providers.id, providerId), sql`coalesce(${providers.settings}->>'rebuild', '') = ''`))
    .returning({ id: providers.id });
  return marked.length > 0;
}

/**
 * Marks the provider so setup runs again, alerts once per loss, then rebuilds. A failed rebuild
 * leaves the mark, so the next held send tries again. Returns whether setup is complete.
 */
export async function rebuildLostSetup(provider: ProviderRow, lost: LostSetup): Promise<boolean> {
  if (await markLost(provider.id, lost)) {
    const detail = `${provider.adapter} no longer has this provider's ${lost.resource}. Mail is held while ${brand.name} rebuilds it.`;
    log.warn(`${provider.id}: ${detail}`);
    const ttl = provider.sharedProviderId ? TENANT_CHECK_TTL_SECONDS : PROVIDER_CHECK_TTL_SECONDS;
    await recordProviderProbe(provider.id, provider.adapter, { ok: false, detail }, ttl);
    await sendPushAlert({ title: `Provider setup lost: ${provider.name}`, message: detail, tags: ["warning", "email"], priority: 4 }).catch(
      (err: Error) => log.warn(`couldn't send the lost-setup alert: ${safeErrorMessage(err)}`),
    );
  }

  const [fresh] = await db.select().from(providers).where(eq(providers.id, provider.id)).limit(1);
  if (!fresh) return false;
  const bound = await db
    .select({ name: domains.name, providerDomainId: domains.providerDomainId })
    .from(domains)
    .where(eq(domains.providerId, provider.id));
  const identities = fresh.settings.rebuild === "tenant" ? bound.map((domain) => domain.providerDomainId ?? domain.name) : undefined;
  const configured = await configureEvents(fresh, bound[0]?.name ?? "", identities);
  if (configured) log.info(`rebuilt the ${lost.resource} for ${provider.id}`);
  return configured;
}
