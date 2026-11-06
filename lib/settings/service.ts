/** Install-wide settings: one `service_settings` row, read and written by id. */
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { isEmailAddress, normalizeAddress } from "@/lib/addresses";
import { SERVICE_SETTINGS_ID, serviceSettings, type ServiceSettingsRow } from "@/lib/db/schema";

export type ServiceSettings = Pick<ServiceSettingsRow, "systemFromAddress" | "systemAlertsTo" | "defaultProviderId">;

const DEFAULTS: ServiceSettings = { systemFromAddress: null, systemAlertsTo: null, defaultProviderId: null };

/** The stored row, or the defaults when nothing has been written yet. */
export async function readServiceSettings(): Promise<ServiceSettings> {
  const [row] = await db
    .select({
      systemFromAddress: serviceSettings.systemFromAddress,
      systemAlertsTo: serviceSettings.systemAlertsTo,
      defaultProviderId: serviceSettings.defaultProviderId,
    })
    .from(serviceSettings)
    .where(eq(serviceSettings.id, SERVICE_SETTINGS_ID))
    .limit(1);
  return row ?? DEFAULTS;
}

async function write(patch: Partial<ServiceSettings>): Promise<void> {
  await db
    .insert(serviceSettings)
    .values({ id: SERVICE_SETTINGS_ID, ...patch })
    .onConflictDoUpdate({
      target: serviceSettings.id,
      set: { ...patch, updatedAt: sql`now()` },
    });
}

/** Sets the address system mail sends from. Null clears it, falling back to the default. */
export async function setSystemFromAddress(address: string | null): Promise<void> {
  await write({ systemFromAddress: address });
}

/** Sets where system alerts go. Null or empty clears it, falling back to the from address. */
export async function setSystemAlertsTo(addresses: string[] | null): Promise<void> {
  await write({ systemAlertsTo: addresses && addresses.length > 0 ? addresses : null });
}

/**
 * Points new organizations at a shared provider. Null clears it. The caller checks the provider
 * is shared — `setDefaultProvider` in lib/providers/admin.ts is the one that does.
 */
export async function setDefaultProviderId(providerId: string | null): Promise<void> {
  await write({ defaultProviderId: providerId });
}

/** The shared provider new organizations are onboarded onto, or null. */
export async function readDefaultProviderId(): Promise<string | null> {
  return (await readServiceSettings()).defaultProviderId;
}

/** The values an admin set in the settings registry, by key. */
export async function readStoredSettings(): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ settings: serviceSettings.settings })
    .from(serviceSettings)
    .where(eq(serviceSettings.id, SERVICE_SETTINGS_ID))
    .limit(1);
  return row?.settings ?? {};
}

/** Stores one registry value, leaving the others as they are. */
export async function setStoredSetting(key: string, value: boolean | number | string): Promise<void> {
  const entry = { [key]: value };
  await db
    .insert(serviceSettings)
    .values({ id: SERVICE_SETTINGS_ID, settings: entry })
    .onConflictDoUpdate({
      target: serviceSettings.id,
      set: { settings: sql`${serviceSettings.settings} || ${JSON.stringify(entry)}::jsonb`, updatedAt: sql`now()` },
    });
}

/** Most addresses the alert recipient setting takes. */
export const MAX_ALERT_RECIPIENTS = 10;

export type AlertRecipientsParse = { ok: true; addresses: string[] } | { ok: false; message: string };

/** Reads addresses separated by commas, semicolons, spaces or new lines. Normalized, deduplicated, empty allowed. */
export function parseAlertRecipients(raw: string): AlertRecipientsParse {
  const addresses: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    if (part === "") continue;
    const address = normalizeAddress(part);
    if (!isEmailAddress(address)) return { ok: false, message: `"${part}" isn't an email address.` };
    if (!addresses.includes(address)) addresses.push(address);
  }
  if (addresses.length > MAX_ALERT_RECIPIENTS) {
    return { ok: false, message: `Use at most ${MAX_ALERT_RECIPIENTS} addresses.` };
  }
  return { ok: true, addresses };
}
