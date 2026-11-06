import { GetAccountCommand, GetTenantCommand } from "@aws-sdk/client-sesv2";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import type { AccountQuota, AdapterHealth } from "../types";
import { log, type SesContext } from "./client";
import { AUTH_NAMES, NOT_FOUND_NAMES, THROTTLED, accessDeniedDetail, isThrottle, reasonOf, statusOf } from "./errors";

export function createAccount(context: SesContext) {
  const { controlClient, stsClient, paced, tenantName } = context;

  /**
   * GetAccount is metadata-only — no identity, no send — so it proves the credentials and the
   * region are reachable without costing anything close to a send. Categorized, not raw: this
   * answer can reach an unauthenticated endpoint.
   */
  async function healthCheck(): Promise<AdapterHealth> {
    if (tenantName) return tenantHealth(tenantName);
    try {
      const account = await paced(() => controlClient.send(new GetAccountCommand({})));
      if (account.SendingEnabled === false) {
        return { ok: false, detail: `Sending is disabled on the account${account.EnforcementStatus ? ` (${account.EnforcementStatus})` : ""}.` };
      }
      return { ok: true, detail: null };
    } catch (err) {
      const name = (err as Error).name;
      const status = statusOf(err);
      const denied = accessDeniedDetail(err);
      if (denied) return { ok: false, detail: denied };
      if (AUTH_NAMES.has(name) || status === 403) return { ok: false, detail: "Credentials were rejected." };
      if (isThrottle(err)) return THROTTLED;
      return { ok: false, detail: "Provider unreachable or returned an error." };
    }
  }

  async function tenantHealth(name: string): Promise<AdapterHealth> {
    try {
      const { Tenant } = await paced(() => controlClient.send(new GetTenantCommand({ TenantName: name })));
      if (Tenant?.SendingStatus === "DISABLED") return { ok: false, detail: "Sending is paused for this organization." };
      return { ok: true, detail: null };
    } catch (err) {
      const errorName = (err as Error).name;
      const status = statusOf(err);
      const denied = accessDeniedDetail(err);
      if (denied) return { ok: false, detail: denied };
      if (NOT_FOUND_NAMES.has(errorName)) return { ok: false, detail: "The tenant isn't set up yet." };
      if (AUTH_NAMES.has(errorName) || status === 403) return { ok: false, detail: "Credentials were rejected." };
      if (isThrottle(err)) return THROTTLED;
      return { ok: false, detail: "Provider unreachable or returned an error." };
    }
  }

  /**
   * The AWS account id these credentials belong to. Not send-scoped and not on GetAccount's own
   * response — GetCallerIdentity is STS's cheapest call, and IAM users need no extra permission
   * grant to call it. Survives a key rotation, unlike hashing the credentials themselves.
   */
  async function identity(): Promise<string | null> {
    try {
      const response = await stsClient.send(new GetCallerIdentityCommand({}));
      return response.Account ?? null;
    } catch (err) {
      log.warn(`fetching the account identity failed: ${reasonOf(err)}`);
      return null;
    }
  }

  async function quota(): Promise<AccountQuota | null> {
    try {
      const account = await paced(() => controlClient.send(new GetAccountCommand({})));
      return {
        max24HourSend: account.SendQuota?.Max24HourSend ?? null,
        maxSendRate: account.SendQuota?.MaxSendRate ?? null,
        sentLast24Hours: account.SendQuota?.SentLast24Hours ?? null,
        enforcementStatus: account.EnforcementStatus ?? null,
      };
    } catch (err) {
      log.warn(`reading the send quota failed: ${reasonOf(err)}`);
      return null;
    }
  }

  return { healthCheck, identity, quota };
}
