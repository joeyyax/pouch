import { GetConfigurationSetCommand, GetTenantCommand, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { brand } from "@/lib/brand";
import { buildMime } from "../mime";
import type { LostSetup, OutboundMessage, Receipt } from "../types";
import type { SesContext } from "./client";
import {
  AUTH_NAMES,
  DAILY_QUOTA_MESSAGE,
  MAIL_FROM_NAME,
  NOT_FOUND_NAMES,
  PAUSE_NAMES,
  isThrottle,
  reasonOf,
  statusOf,
  tolerateMissing,
} from "./errors";

const DEFAULT_BACKOFF_SECONDS = 60;
const PAUSE_BACKOFF_SECONDS = 15 * 60;
const REBUILD_BACKOFF_SECONDS = 5 * 60;
// The daily quota is a rolling 24 hours with no reset time; SES says to wait up to 10 minutes.
const DAILY_QUOTA_BACKOFF_SECONDS = 10 * 60;

export function createSending(context: SesContext) {
  const { sesClient, controlClient, paced, tenantName, configurationSetName } = context;

  /** Which of the resources a send names SES no longer has. Throws when it can't tell. */
  async function lostSetup(): Promise<LostSetup | null> {
    if (tenantName && !(await tolerateMissing(paced(() => controlClient.send(new GetTenantCommand({ TenantName: tenantName })))))) {
      return { resource: "tenant", settings: { rebuild: "tenant", tenantArn: "", configurationSetAssociated: "" } };
    }
    if (
      configurationSetName &&
      !(await tolerateMissing(paced(() => controlClient.send(new GetConfigurationSetCommand({ ConfigurationSetName: configurationSetName })))))
    ) {
      return { resource: "configuration set", settings: { rebuild: "configuration set", ...(tenantName ? { configurationSetAssociated: "" } : {}) } };
    }
    return null;
  }

  async function send(message: OutboundMessage): Promise<Receipt> {
    try {
      const response = await sesClient.send(
        new SendEmailCommand({
          FromEmailAddress: message.from.name ? `${message.from.name} <${message.from.address}>` : message.from.address,
          Destination: {
            ToAddresses: message.to,
            CcAddresses: message.cc,
            BccAddresses: message.bcc,
          },
          ReplyToAddresses: message.replyTo.length > 0 ? message.replyTo : undefined,
          ...(configurationSetName ? { ConfigurationSetName: configurationSetName } : {}),
          ...(tenantName ? { TenantName: tenantName } : {}),
          Content: { Raw: { Data: Buffer.from(buildMime(message), "utf8") } },
        }),
      );

      if (!response.MessageId) {
        return { successful: false, errors: ["Provider accepted the message without an id."], failure: "transient" };
      }
      return { successful: true, providerMessageId: response.MessageId };
    } catch (err) {
      const errors = [reasonOf(err)];
      const name = (err as Error).name;
      const status = statusOf(err);

      if (isThrottle(err)) {
        const retryAfterSeconds = DAILY_QUOTA_MESSAGE.test(reasonOf(err)) ? DAILY_QUOTA_BACKOFF_SECONDS : DEFAULT_BACKOFF_SECONDS;
        return { successful: false, errors, failure: "backoff", retryAfterSeconds, accountWide: true };
      }
      // Tenants hold copies of the shared account's credentials.
      if (AUTH_NAMES.has(name)) {
        return { successful: false, errors, failure: "backoff", retryAfterSeconds: PAUSE_BACKOFF_SECONDS, accountWide: true };
      }
      if (PAUSE_NAMES.has(name)) {
        return { successful: false, errors, failure: "backoff", retryAfterSeconds: PAUSE_BACKOFF_SECONDS };
      }
      if (name === MAIL_FROM_NAME) {
        const domain = message.from.address.split("@").pop() ?? "";
        return { successful: false, errors: [...errors, `SES rejects mail from ${domain} until its MAIL FROM domain verifies.`], failure: "permanent" };
      }
      if (NOT_FOUND_NAMES.has(name)) {
        let lost: LostSetup | null;
        try {
          lost = await lostSetup();
        } catch (probeErr) {
          return { successful: false, errors: [...errors, `Couldn't check what SES is missing: ${reasonOf(probeErr)}`], failure: "transient" };
        }
        if (lost) {
          const note = `SES no longer has this account's ${lost.resource}. ${brand.name} is rebuilding it.`;
          return { successful: false, errors: [...errors, note], failure: "backoff", retryAfterSeconds: REBUILD_BACKOFF_SECONDS, lostSetup: lost };
        }
      }
      if (status >= 500 || status === 0 || status === 408) {
        return { successful: false, errors, failure: "transient" };
      }
      return { successful: false, errors, failure: "permanent" };
    }
  }

  return { send };
}
