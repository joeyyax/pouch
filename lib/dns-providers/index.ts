import type { z } from "zod";
import { cloudflare } from "./cloudflare";
import { mock } from "./mock";
import { route53 } from "./route53";
import type { DnsProvider, DnsProviderCapabilities, DnsProviderModule, DnsProviderSettings } from "./types";

const MODULES: Record<string, DnsProviderModule> = {
  cloudflare,
  route53,
  mock,
};

export const DNS_PROVIDER_MODULES = Object.keys(MODULES);

/** The module's descriptor, or throws. Reading it needs no credentials and no live provider. */
function moduleOf(module: string): DnsProviderModule {
  const descriptor = MODULES[module];
  if (!descriptor) throw new Error(`Unknown DNS provider module "${module}".`);
  return descriptor;
}

export function buildDnsProvider(
  module: string,
  credentials: Record<string, string>,
  settings: DnsProviderSettings = {},
  accountId = "?",
): DnsProvider {
  return moduleOf(module).create(credentials, settings, accountId);
}

export function dnsCapabilitiesOf(module: string): DnsProviderCapabilities {
  return moduleOf(module).capabilities;
}

/** What the module needs to be configured with. The dashboard reads this. */
export function dnsCredentialsSchemaOf(module: string): z.ZodObject {
  return moduleOf(module).credentialsSchema;
}

export function dnsSettingsSchemaOf(module: string): z.ZodObject {
  return moduleOf(module).settingsSchema;
}

export type * from "./types";
