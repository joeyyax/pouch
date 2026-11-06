import type { Adapter, AdapterFactory, AdapterModule } from "../types";
import { createAccount } from "./account";
import { sesContext } from "./client";
import { conversionPlan, createConversion } from "./conversion";
import { createDomains } from "./domains";
import { createEvents } from "./events";
import { createInbound } from "./inbound";
import { createReputation } from "./reputation";
import { createSending } from "./sending";
import { capabilities, credentialsSchema, isConfigured, settingsSchema } from "./settings";
import { createSetup } from "./setup";
import { createTenants } from "./tenants";

export { SEND_TIMEOUT_MS } from "./client";
export { SIMULATE_PERMISSION, principalArn } from "./conversion";
export { ACCOUNT_TAG, TENANT_TAG } from "./domains";
export { API_RETRY, ApiRateTimeoutError } from "./errors";
export { CERTIFICATE_TIMEOUT_MS, MAX_CACHED_CERTIFICATES, cachedCertificateCount, resetCertificateCache } from "./events";
export { INBOUND_KEY_PREFIX, INBOUND_RULE_PREFIX, inboundKeyParts } from "./inbound";
export { CLOUDWATCH_PERMISSION, REPUTATION_LOOKBACK_HOURS } from "./reputation";
export { tenantIdFromArn, tenantNameFromArn } from "./tenants";

const create: AdapterFactory = (credentials, settings, accountId, options = {}): Adapter => {
  const context = sesContext(credentials, settings, accountId, options);
  const { healthCheck, identity, quota } = createAccount(context);
  const tenants = createTenants(context, identity);
  const { parseStatus, tenantStatus } = tenants;
  const { reputationRates, tenantVolume, tenantFindings } = createReputation(context);

  return {
    adapter: "ses",
    capabilities,
    send: createSending(context).send,
    canHealthCheck: true,
    healthCheck,
    identity,
    quota,
    reputationRates,
    conversion: createConversion(context, tenants),
    domain: createDomains(context, tenants),
    setup: createSetup(context, tenants),
    ...(context.sharing === "operator" ? { tenants: { parseStatus, status: tenantStatus, findings: tenantFindings, volume: tenantVolume } } : {}),
    inbound: createInbound(context),
    events: createEvents(context),
  };
};

export const ses: AdapterModule = {
  adapter: "ses",
  capabilities,
  credentialsSchema,
  settingsSchema,
  isConfigured,
  conversionPlan,
  create,
};
