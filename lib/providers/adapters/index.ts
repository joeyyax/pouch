import type { z } from "zod";
import { cloudflare } from "./cloudflare";
import { mailpace } from "./mailpace";
import { mock } from "./mock";
import { ses } from "./ses";
import { stepsFor } from "./setup";
import type {
  Adapter,
  AdapterCapabilities,
  AdapterModule,
  AdapterOptions,
  ConversionPlanner,
  ProviderSettings,
  SetupStep,
  WebhookTarget,
} from "./types";

/**
 * One descriptor per adapter. Capabilities, the schemas and `isConfigured` live on the descriptor
 * rather than on the built Adapter: answering those questions must never decrypt an account's
 * credentials, and building an Adapter does.
 */
const ADAPTERS: Record<string, AdapterModule> = {
  cloudflare,
  mailpace,
  mock,
  ses,
};

export const ADAPTER_KEYS = Object.keys(ADAPTERS);

/** Every flag an adapter must declare. An adapter missing one fails tests/unit/provider-registry.test.ts. */
export const CAPABILITY_KEYS = [
  "customHeaders",
  "maxAttachmentBytes",
  "maxRecipients",
  "bulk",
  "domainsViaApi",
  "dnsRecordsViaApi",
  "webhooksViaApi",
  "removalViaApi",
  "adoptionViaApi",
  "credentialsWithoutConsole",
  "sharing",
  "subdomainSending",
] as const satisfies readonly (keyof AdapterCapabilities)[];

/** The adapter's descriptor, or throws. Reading it needs no credentials and no live Adapter. */
function moduleOf(adapter: string): AdapterModule {
  const descriptor = ADAPTERS[adapter];
  if (!descriptor) throw new Error(`Unknown provider adapter "${adapter}".`);
  return descriptor;
}

export function buildAdapter(
  adapter: string,
  credentials: Record<string, string>,
  settings: ProviderSettings = {},
  accountId = "?",
  options: AdapterOptions = {},
): Adapter {
  return moduleOf(adapter).create(credentials, settings, accountId, options);
}

/** What an adapter supports, without needing its credentials. */
export function capabilitiesOf(adapter: string): AdapterCapabilities {
  return moduleOf(adapter).capabilities;
}

/** The zod schema an adapter's credentials have to satisfy. */
export function credentialsSchemaOf(adapter: string): z.ZodObject {
  return moduleOf(adapter).credentialsSchema;
}

/** The zod schema an adapter's settings have to satisfy. */
export function settingsSchemaOf(adapter: string): z.ZodObject {
  return moduleOf(adapter).settingsSchema;
}

/** Whether the account's event plumbing is finished. Settings only — never credentials. */
export function isConfiguredFor(adapter: string, settings: ProviderSettings): boolean {
  return ADAPTERS[adapter]?.isConfigured?.(settings) ?? true;
}

/** What converting an account into a tenant would need and call, per adapter. Never credentials. */
export function conversionPlanOf(adapter: string): ConversionPlanner | null {
  return ADAPTERS[adapter]?.conversionPlan ?? null;
}

/** Adapters that declare a setup step, so the descriptors can be checked against them. */
export function adaptersWithSetup(): string[] {
  return ADAPTER_KEYS.filter((adapter) => ADAPTERS[adapter]?.isConfigured);
}

/** The steps an adapter leaves to the vendor console. */
export function setupSteps(adapter: string, context: WebhookTarget, eventsConfigured = true): SetupStep[] {
  return stepsFor(capabilitiesOf(adapter), context, eventsConfigured);
}

export { stepsFor };

export type * from "./types";
