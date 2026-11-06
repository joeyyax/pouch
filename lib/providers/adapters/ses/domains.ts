import {
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  DeleteTenantResourceAssociationCommand,
  GetEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
  TagResourceCommand,
  type DkimStatus,
  type GetEmailIdentityResponse,
  type MailFromDomainStatus,
} from "@aws-sdk/client-sesv2";
import type { Adapter, AdoptedDomain, CreatedDomain, ProposedDnsRecord, VerificationStatus } from "../types";
import { DomainNotAtProviderError, DomainUnavailableError } from "../types";
import { log, type SesContext } from "./client";
import { reasonOf, tolerateExisting, tolerateMissing } from "./errors";
import type { SesTenants } from "./tenants";

/** Tags an identity with the tenant that created it, so another tenant can't claim it. */
export const TENANT_TAG = "mail-tenant";
/** Tags an identity with the ordinary provider that created it. */
export const ACCOUNT_TAG = "mail-account";

export interface OwnerTag {
  Key: string;
  Value: string;
}

export function ownedBy(identity: GetEmailIdentityResponse, owner: OwnerTag): boolean {
  return (identity.Tags ?? []).some((tag) => tag.Key === owner.Key && tag.Value === owner.Value);
}

export function claimed(identity: GetEmailIdentityResponse): boolean {
  return (identity.Tags ?? []).some((tag) => tag.Key === TENANT_TAG || tag.Key === ACCOUNT_TAG);
}

// `verified` (below) keys off DKIM alone, so the DKIM CNAMEs are required and the MAIL FROM
// records aren't — a domain sends without MAIL FROM confirmed, just with a weaker envelope sender.

function dkimRecords(tokens: string[], name: string): ProposedDnsRecord[] {
  return tokens.map((token) => ({
    type: "CNAME" as const,
    name: `${token}._domainkey.${name}`,
    value: `${token}.dkim.amazonses.com`,
    required: true,
  }));
}

/** `host` is the identity's own MAIL FROM domain, which an adopted identity may already have set. */
function mailFromRecords(host: string, region: string): ProposedDnsRecord[] {
  return [
    { type: "MX", name: host, value: `feedback-smtp.${region}.amazonses.com`, priority: 10, required: false },
    { type: "TXT", name: host, value: "v=spf1 include:amazonses.com ~all", required: false },
  ];
}

/** What one of SESv2's verification statuses says about a domain. */
type StatusVerdict = "present" | "missing" | "failed" | "inconclusive";

/** Every SESv2 DkimStatus. TEMPORARY_FAILURE is SES saying it couldn't determine the status. */
const DKIM_VERDICTS: Record<DkimStatus, StatusVerdict> = {
  SUCCESS: "present",
  PENDING: "missing",
  NOT_STARTED: "missing",
  FAILED: "failed",
  TEMPORARY_FAILURE: "inconclusive",
};

const MAIL_FROM_VERDICTS: Record<MailFromDomainStatus, StatusVerdict> = {
  SUCCESS: "present",
  PENDING: "missing",
  FAILED: "failed",
  TEMPORARY_FAILURE: "inconclusive",
};

/** A status this map doesn't carry reads as inconclusive, never as unverified. */
function verdictOf(verdicts: Partial<Record<string, StatusVerdict>>, status: string): StatusVerdict {
  return verdicts[status] ?? "inconclusive";
}

function mailFromDomain(name: string): string {
  return `mail.${name}`;
}

export function createDomains(context: SesContext, tenants: SesTenants): Adapter["domain"] {
  const { accountId, region, controlClient, paced, sesArn, tenantName } = context;
  const { ensureTenant, arnAnchor, associate } = tenants;
  const owner: OwnerTag = tenantName ? { Key: TENANT_TAG, Value: tenantName } : { Key: ACCOUNT_TAG, Value: accountId };

  return {
    async create(name: string): Promise<CreatedDomain> {
      // An existing identity is ours only when tagged as ours: a retry of a create that failed before the row landed.
      const fresh = await tolerateExisting(
        paced(() => controlClient.send(
          new CreateEmailIdentityCommand({
            EmailIdentity: name,
            DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" },
            Tags: [owner],
          }),
        )),
      );
      let created: { DkimAttributes?: { Tokens?: string[] } } | null = fresh;
      if (!created) {
        const existing = await paced(() => controlClient.send(new GetEmailIdentityCommand({ EmailIdentity: name })));
        if (!ownedBy(existing, owner)) throw new DomainUnavailableError(name);
        created = existing;
      }

      // A custom MAIL FROM domain is what makes bounces come back to SES rather than the sender.
      await paced(() => controlClient.send(
        new PutEmailIdentityMailFromAttributesCommand({
          EmailIdentity: name,
          MailFromDomain: mailFromDomain(name),
          BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
        }),
      ));

      if (tenantName) {
        const arn = await ensureTenant(tenantName);
        await associate(tenantName, sesArn(arn, `identity/${name}`));
      }

      return {
        providerDomainId: name,
        records: [...dkimRecords(created.DkimAttributes?.Tokens ?? [], name), ...mailFromRecords(mailFromDomain(name), region)],
      };
    },

    /**
     * Takes over an identity SES already holds. Never calls CreateEmailIdentity, so the DKIM
     * tokens and their published CNAMEs stay as they are and sending doesn't stop.
     */
    async adopt(name: string): Promise<AdoptedDomain> {
      const existing = await tolerateMissing(paced(() => controlClient.send(new GetEmailIdentityCommand({ EmailIdentity: name }))));
      if (!existing) throw new DomainNotAtProviderError(name);
      // Untagged means unclaimed. A tag naming anyone else stays refused.
      if (claimed(existing) && !ownedBy(existing, owner)) throw new DomainUnavailableError(name);

      const arn = sesArn(await arnAnchor(), `identity/${name}`);
      if (!ownedBy(existing, owner)) await paced(() => controlClient.send(new TagResourceCommand({ ResourceArn: arn, Tags: [owner] })));
      if (tenantName) await associate(tenantName, arn);

      // Only when the identity has none: overwriting a MAIL FROM someone else configured would
      // change how their bounces come back.
      const existingMailFrom = existing.MailFromAttributes?.MailFromDomain ?? null;
      if (!existingMailFrom) {
        await paced(() => controlClient.send(
          new PutEmailIdentityMailFromAttributesCommand({
            EmailIdentity: name,
            MailFromDomain: mailFromDomain(name),
            BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
          }),
        ));
      }

      const tokens = existing.DkimAttributes?.Tokens ?? [];
      return {
        providerDomainId: name,
        records: [...dkimRecords(tokens, name), ...mailFromRecords(existingMailFrom ?? mailFromDomain(name), region)],
        sending: existing.VerifiedForSendingStatus === true,
        dkimTokens: tokens,
        existingMailFromDomain: existingMailFrom,
      };
    },

    async verify(name: string): Promise<VerificationStatus> {
      let identity;
      try {
        identity = await paced(() => controlClient.send(new GetEmailIdentityCommand({ EmailIdentity: name })));
      } catch (err) {
        return { answered: false, verified: false, missing: [], errors: [reasonOf(err)] };
      }

      const dkimStatus = identity.DkimAttributes?.Status ?? "NOT_STARTED";
      const mailFromStatus = identity.MailFromAttributes?.MailFromDomainStatus ?? "NOT_STARTED";
      const dkim = verdictOf(DKIM_VERDICTS, dkimStatus);
      const sending = identity.VerifiedForSendingStatus === true;

      // Either SES couldn't determine DKIM, or it withholds sending from a domain whose DKIM it
      // calls SUCCESS. Neither states where the domain stands.
      if (dkim === "inconclusive" || (dkim === "present" && !sending)) {
        return {
          answered: false,
          verified: false,
          missing: [],
          errors: [`SES reports DKIM ${dkimStatus} with VerifiedForSendingStatus ${sending}.`],
        };
      }

      const mailFrom = verdictOf(MAIL_FROM_VERDICTS, mailFromStatus);
      const missing: ProposedDnsRecord[] = [];
      const errors: string[] = [];

      if (dkim !== "present") {
        missing.push(...dkimRecords(identity.DkimAttributes?.Tokens ?? [], name));
        if (dkim === "failed") errors.push(`DKIM verification is ${dkimStatus}. Recreate the domain.`);
      }
      if (mailFrom !== "present") {
        // The identity's own MAIL FROM domain, which an adopted identity may have set elsewhere.
        missing.push(...mailFromRecords(identity.MailFromAttributes?.MailFromDomain || mailFromDomain(name), region));
        if (mailFrom === "failed") errors.push(`MAIL FROM verification is ${mailFromStatus}.`);
      }

      return { answered: true, verified: dkim === "present", missing, errors };
    },

    async remove(name: string): Promise<void> {
      const identity = await tolerateMissing(paced(() => controlClient.send(new GetEmailIdentityCommand({ EmailIdentity: name }))));
      if (!identity) return;
      // An untagged identity on an ordinary account predates tagging; the row calling this binds it here.
      const ours = ownedBy(identity, owner) || (!tenantName && !claimed(identity));
      if (!ours) {
        log.warn(`not removing ${name}: another account holds it`);
        return;
      }
      if (tenantName) {
        // SES refuses to delete an identity that's still associated with a tenant.
        const arn = await ensureTenant(tenantName);
        await tolerateMissing(
          paced(() => controlClient.send(new DeleteTenantResourceAssociationCommand({ TenantName: tenantName, ResourceArn: sesArn(arn, `identity/${name}`) }))),
        );
      }
      await tolerateMissing(paced(() => controlClient.send(new DeleteEmailIdentityCommand({ EmailIdentity: name }))));
    },
  };
}
