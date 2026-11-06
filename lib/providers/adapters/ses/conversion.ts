import {
  GetEmailIdentityCommand,
  ListSuppressedDestinationsCommand,
  PutSuppressedDestinationCommand,
  TagResourceCommand,
  type SuppressionListReason,
} from "@aws-sdk/client-sesv2";
import { IAMClient, SimulatePrincipalPolicyCommand } from "@aws-sdk/client-iam";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import type { ConversionPlanner, ConversionResources, ConversionStep, TenantConversion } from "../types";
import { DomainUnavailableError } from "../types";
import type { SesContext } from "./client";
import { ACCOUNT_TAG, TENANT_TAG, claimed, ownedBy, type OwnerTag } from "./domains";
import { isAccessDenied, tolerateMissing } from "./errors";
import type { SesTenants } from "./tenants";

const CONVERSION_PERMISSIONS: Record<ConversionStep, string[]> = {
  parent_setup: ["sns:CreateTopic", "sns:SetTopicAttributes", "sns:Subscribe", "events:PutRule", "events:PutTargets"],
  tenant: ["ses:CreateTenant", "ses:GetTenant", "ses:PutTenantSuppressionAttributes"],
  associate: ["ses:GetEmailIdentity", "ses:CreateTenantResourceAssociation"],
  tag: ["ses:TagResource"],
  suppression: ["ses:ListSuppressedDestinations", "ses:PutSuppressedDestination"],
};

/** Checked on every conversion: a tenant's sends name the tenant. */
const CONVERTED_SEND_PERMISSIONS = ["ses:SendEmail"];

export const SIMULATE_PERMISSION = "iam:SimulatePrincipalPolicy";

function conversionCalls(step: ConversionStep | "preflight", name: string, resources: ConversionResources): string[] {
  switch (step) {
    case "preflight":
      return ["STS GetCallerIdentityCommand", "IAM SimulatePrincipalPolicyCommand PolicySourceArn=<caller>"];
    case "parent_setup":
      return [
        "SNS CreateTopicCommand Name=mail-tenant-status-<parent id>",
        "EventBridge PutRuleCommand Name=mail-tenant-status-<parent id>",
        "SNS SetTopicAttributesCommand AttributeName=Policy",
        "SNS SetTopicAttributesCommand AttributeName=SignatureVersion",
        "SNS SetTopicAttributesCommand AttributeName=DeliveryPolicy",
        "SNS SubscribeCommand Endpoint=/api/webhooks/ses/<parent id>",
        "EventBridge PutTargetsCommand Rule=mail-tenant-status-<parent id>",
      ];
    case "tenant":
      return [`SESv2 CreateTenantCommand TenantName=${name} SuppressionScope=TENANT`];
    case "associate":
      return [
        ...resources.identities.map((identity) => `SESv2 GetEmailIdentityCommand EmailIdentity=${identity}`),
        `SESv2 CreateTenantResourceAssociationCommand TenantName=${name} ResourceArn=…:configuration-set/${resources.configurationSetName}`,
        ...resources.identities.map(
          (identity) => `SESv2 CreateTenantResourceAssociationCommand TenantName=${name} ResourceArn=…:identity/${identity}`,
        ),
      ];
    case "tag":
      return resources.identities.map((identity) => `SESv2 TagResourceCommand ResourceArn=…:identity/${identity} Tags=${TENANT_TAG}=${name}`);
    case "suppression":
      return [
        `SESv2 ListSuppressedDestinationsCommand TenantName=${name} (every page)`,
        "SESv2 ListSuppressedDestinationsCommand (account list, every page)",
        `SESv2 PutSuppressedDestinationCommand TenantName=${name} (once per address missing from the tenant list)`,
      ];
  }
}

/** The static half of a conversion: what it needs and calls. Reading it needs no credentials. */
export const conversionPlan: ConversionPlanner = {
  permissions: (steps) => [...new Set([...steps.flatMap((step) => CONVERSION_PERMISSIONS[step]), ...CONVERTED_SEND_PERMISSIONS])],
  calls: conversionCalls,
};

const SUPPRESSION_PAGE_SIZE = 1000;

/** The IAM principal a caller ARN acts as, or null for the root user. */
export function principalArn(callerArn: string): string | null {
  const [, partition, service, , account, resource = ""] = callerArn.split(":");
  if (resource === "root") return null;
  if (service === "sts" && resource.startsWith("assumed-role/")) {
    return `arn:${partition}:iam::${account}:role/${resource.split("/")[1]}`;
  }
  return callerArn;
}

export function createConversion(context: SesContext, tenants: SesTenants): TenantConversion {
  const { accountId, clientConfig, controlClient, stsClient, paced, sesArn } = context;
  const { ensureTenant, associate } = tenants;

  async function missingPermissions(actions: string[]): Promise<string[]> {
    const caller = await stsClient.send(new GetCallerIdentityCommand({}));
    if (!caller.Arn) throw new Error("STS returned no caller ARN.");
    const principal = principalArn(caller.Arn);
    if (!principal) return [];
    const iamClient = new IAMClient(clientConfig);
    const missing: string[] = [];
    let marker: string | undefined;
    try {
      do {
        const response = await iamClient.send(
          new SimulatePrincipalPolicyCommand({ PolicySourceArn: principal, ActionNames: actions, Marker: marker }),
        );
        for (const result of response.EvaluationResults ?? []) {
          if (result.EvalDecision !== "allowed" && result.EvalActionName) missing.push(result.EvalActionName);
        }
        marker = response.IsTruncated ? response.Marker : undefined;
      } while (marker);
    } catch (err) {
      if (isAccessDenied(err)) return [SIMULATE_PERMISSION];
      throw err;
    }
    return missing;
  }

  async function associateExisting(name: string, arn: string, resources: ConversionResources): Promise<void> {
    const accountOwner: OwnerTag = { Key: ACCOUNT_TAG, Value: accountId };
    const tenantOwner: OwnerTag = { Key: TENANT_TAG, Value: name };
    for (const identity of resources.identities) {
      const found = await tolerateMissing(paced(() => controlClient.send(new GetEmailIdentityCommand({ EmailIdentity: identity }))));
      if (!found) throw new Error(`SES has no identity ${identity}.`);
      if (!ownedBy(found, accountOwner) && !ownedBy(found, tenantOwner) && claimed(found)) throw new DomainUnavailableError(identity);
    }
    await associate(name, sesArn(arn, `configuration-set/${resources.configurationSetName}`));
    for (const identity of resources.identities) await associate(name, sesArn(arn, `identity/${identity}`));
  }

  async function tagIdentities(name: string, arn: string, identities: string[]): Promise<void> {
    for (const identity of identities) {
      await paced(() => controlClient.send(
        new TagResourceCommand({ ResourceArn: sesArn(arn, `identity/${identity}`), Tags: [{ Key: TENANT_TAG, Value: name }] }),
      ));
    }
  }

  async function suppressedAddresses(name?: string): Promise<Map<string, SuppressionListReason>> {
    const found = new Map<string, SuppressionListReason>();
    let token: string | undefined;
    do {
      const page = await paced(() => controlClient.send(
        new ListSuppressedDestinationsCommand({ TenantName: name, NextToken: token, PageSize: SUPPRESSION_PAGE_SIZE }),
      ));
      for (const entry of page.SuppressedDestinationSummaries ?? []) {
        if (entry.EmailAddress && entry.Reason) found.set(entry.EmailAddress.toLowerCase(), entry.Reason);
      }
      token = page.NextToken;
    } while (token);
    return found;
  }

  async function copySuppressions(name: string): Promise<number> {
    const present = await suppressedAddresses(name);
    const account = await suppressedAddresses();
    let added = 0;
    for (const [address, reason] of account) {
      if (present.has(address)) continue;
      await paced(() => controlClient.send(
        new PutSuppressedDestinationCommand({ EmailAddress: address, Reason: reason, TenantName: name }),
      ));
      added += 1;
    }
    return added;
  }

  const conversion: TenantConversion = {
    ...conversionPlan,
    missingPermissions,
    ensureTenant,
    associate: associateExisting,
    tagIdentities,
    copySuppressions,
  };

  return conversion;
}
