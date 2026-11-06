import { z } from "zod";
import type { AdapterCapabilities, ProviderSettings } from "../types";

// SES accepts 40 MB per message including base64 overhead, so the decoded ceiling sits below it.
// 50 destinations per send is SES's own limit.
export const capabilities: AdapterCapabilities = {
  customHeaders: true,
  maxAttachmentBytes: 25 * 1024 * 1024,
  maxRecipients: 50,
  bulk: true,
  domainsViaApi: true,
  dnsRecordsViaApi: true,
  webhooksViaApi: true,
  removalViaApi: true,
  // An identity already at SES is tagged and attached in place, keeping its DKIM.
  adoptionViaApi: true,
  // One account credential sends for every domain, so nothing is left for the console.
  credentialsWithoutConsole: true,
  sharing: true,
  // A subdomain inherits the domain identity's verification and Easy DKIM, signed d=<domain>.
  subdomainSending: true,
};

export const credentialsSchema = z.object({
  accessKeyId: z.string().min(1).describe("Access key id for an IAM user with SES and SNS access."),
  secretAccessKey: z.string().min(1).describe("Secret access key for that user."),
  region: z.string().min(1).describe("AWS region the SES identities live in, such as us-west-2."),
  inboundBucket: z
    .string()
    .min(1)
    .optional()
    .describe("S3 bucket, in the same region, that SES writes received mail to. Leave empty and inbound stays off."),
});

export const settingsSchema = z.object({
  configurationSetName: z.string().min(1).optional().describe("Configuration set that publishes this account's events."),
  topicArn: z.string().min(1).optional().describe("SNS topic the event destination publishes to."),
  subscriptionConfirmed: z
    .string()
    .optional()
    .describe('Set to "true" once SNS has confirmed the subscription to that topic.'),
});

/** Written by Pouch, never by a caller: the public schema above strips them. */
export interface InternalSettings {
  /** Set on a tenant row. */
  tenantName?: string;
  tenantArn?: string;
  configurationSetAssociated?: string;
  /** "operator" on a shared account. */
  sharing?: string;
  eventRuleArn?: string;
  /** Set while a lost resource waits to be rebuilt. */
  rebuild?: string;
  /** `TENANT_UNREQUESTED` on a tenant row until its first CreateTenant attempt. */
  tenantState?: string;
}

export type SesSettings = z.infer<typeof settingsSchema> & InternalSettings;

/**
 * Whether this account's event plumbing is finished. Events only arrive once SNS has confirmed
 * the subscription, so that's the finish line. Reads settings and nothing else, so the registry
 * can answer it without decrypting the account's credentials.
 */
export function isConfigured(current: ProviderSettings): boolean {
  const subscribed = Boolean(current.topicArn && current.subscriptionConfirmed === "true");
  if (current.sharing === "operator") return subscribed && Boolean(current.eventRuleArn);
  if (current.rebuild) return false;
  const base = subscribed && Boolean(current.configurationSetName);
  if (current.tenantName) return base && Boolean(current.tenantArn) && current.configurationSetAssociated === "true";
  return base;
}
