import {
  CreateTenantCommand,
  CreateTenantResourceAssociationCommand,
  DeleteConfigurationSetCommand,
  DeleteTenantCommand,
  DeleteTenantResourceAssociationCommand,
  GetTenantCommand,
  PutTenantSuppressionAttributesCommand,
  type TenantSuppressionAttributes,
} from "@aws-sdk/client-sesv2";
import { DeleteTopicCommand } from "@aws-sdk/client-sns";
import type { SignedRequest, TenantSendingStatus, TenantStatusEvent } from "../types";
import { TENANT_UNREQUESTED } from "../types";
import { resourceName, type SesContext } from "./client";
import { tolerateExisting, tolerateMissing } from "./errors";
import type { SesSettings } from "./settings";
import { parseEnvelope } from "./sns";

const TENANT_SUPPRESSION: TenantSuppressionAttributes = { SuppressionScope: "TENANT", SuppressedReasons: ["BOUNCE", "COMPLAINT"] };

/** EventBridge detail-types SES emits for tenants. */
export const TENANT_STATUS_KINDS: Record<string, TenantStatusEvent["kind"]> = {
  "Sending Status Enabled": "sending_enabled",
  "Sending Status Disabled": "sending_disabled",
  "Advisor Recommendation Status Open": "finding_opened",
  "Advisor Recommendation Status Closed": "finding_closed",
};

/** The id SES appends to a tenant ARN: `tenant/<name>/<id>`. */
export function tenantIdFromArn(arn: string): string | null {
  const parts = arn.split(":").slice(5).join(":").split("/");
  return parts[0] === "tenant" && parts.length === 3 ? (parts[2] ?? null) : null;
}

/** The tenant name inside a tenant ARN, when the ARN carries one. */
export function tenantNameFromArn(arn: string): string | null {
  const resource = arn.split(":").slice(5).join(":");
  const parts = resource.split("/");
  return parts[0] === "tenant" && parts.length === 3 ? (parts[1] ?? null) : null;
}

interface TenantStatusPayload {
  source?: string;
  "detail-type"?: string;
  resources?: string[];
  detail?: Record<string, unknown>;
}

export function createTenants(context: SesContext, identity: () => Promise<string | null>) {
  const { settings, options, accountId, region, controlClient, snsClient, paced, sesArn, tenantName, topicArn, configurationSetName } = context;
  let tenantArn = (settings as SesSettings).tenantArn;
  let tenantRequested = (settings as SesSettings).tenantState !== TENANT_UNREQUESTED;

  /** Creates the tenant, or finds it from an earlier attempt, and returns its ARN. */
  async function ensureTenant(name: string): Promise<string> {
    if (tenantArn) return tenantArn;
    if (!tenantRequested) {
      // Recorded first: teardown skips AWS only while no attempt could have created a tenant.
      if (!options.saveSettings) throw new Error("A tenant can't be requested without recording the request.");
      await options.saveSettings({ tenantState: "requested" });
      tenantRequested = true;
    }
    const created = await tolerateExisting(
      paced(() => controlClient.send(new CreateTenantCommand({ TenantName: name, SuppressionAttributes: TENANT_SUPPRESSION }))),
    );
    let arn = created?.TenantArn;
    if (!created) {
      // A retry: the first attempt may have stopped before the suppression settings were known to stick.
      const existing = await paced(() => controlClient.send(new GetTenantCommand({ TenantName: name })));
      arn = existing.Tenant?.TenantArn;
      await paced(() => controlClient.send(new PutTenantSuppressionAttributesCommand({ TenantName: name, ...TENANT_SUPPRESSION })));
    }
    if (!arn) throw new Error("SES created the tenant without an ARN.");
    tenantArn = arn;
    return arn;
  }

  /** An ARN in this row's own region and AWS account: the tenant's, or one STS names. */
  async function arnAnchor(): Promise<string> {
    if (tenantName) return ensureTenant(tenantName);
    const account = await identity();
    if (!account) throw new Error("STS didn't report the AWS account these credentials belong to.");
    return `arn:aws:ses:${region}:${account}:identity/*`;
  }

  async function associate(name: string, resourceArn: string): Promise<void> {
    await tolerateExisting(
      paced(() => controlClient.send(new CreateTenantResourceAssociationCommand({ TenantName: name, ResourceArn: resourceArn }))),
    );
  }

  async function teardownTenant(name: string): Promise<void> {
    if (!tenantArn && !tenantRequested) return;
    const arn = tenantArn ?? (await tolerateMissing(paced(() => controlClient.send(new GetTenantCommand({ TenantName: name })))))?.Tenant?.TenantArn;
    const configSet = configurationSetName ?? resourceName(accountId);
    if (arn) {
      await tolerateMissing(
        paced(() => controlClient.send(
          new DeleteTenantResourceAssociationCommand({ TenantName: name, ResourceArn: sesArn(arn, `configuration-set/${configSet}`) }),
        )),
      );
    }
    await tolerateMissing(paced(() => controlClient.send(new DeleteConfigurationSetCommand({ ConfigurationSetName: configSet }))));
    if (topicArn) await snsClient.send(new DeleteTopicCommand({ TopicArn: topicArn }));
    await tolerateMissing(paced(() => controlClient.send(new DeleteTenantCommand({ TenantName: name }))));
  }

  function parseStatus(request: SignedRequest): TenantStatusEvent[] {
    const envelope = parseEnvelope(request.rawBody);
    if (!envelope || envelope.Type !== "Notification" || !topicArn || envelope.TopicArn !== topicArn) return [];
    let payload: TenantStatusPayload;
    try {
      payload = JSON.parse(envelope.Message) as TenantStatusPayload;
    } catch {
      return [];
    }
    const kind = payload.source === "aws.ses" ? TENANT_STATUS_KINDS[payload["detail-type"] ?? ""] : undefined;
    if (!kind) return [];
    return (payload.resources ?? [])
      .filter((ref) => ref.includes(":tenant/"))
      .map((ref) => ({ kind, tenantRef: ref, tenantName: tenantNameFromArn(ref), detail: payload.detail ?? {} }));
  }

  async function tenantStatus(name: string): Promise<TenantSendingStatus | null> {
    const response = await tolerateMissing(paced(() => controlClient.send(new GetTenantCommand({ TenantName: name }))));
    if (!response) return null;
    const status = response.Tenant?.SendingStatus;
    if (status === "DISABLED") return "disabled";
    if (status === "ENABLED" || status === "REINSTATED") return "enabled";
    throw new Error(`SES returned no known sending status for tenant ${name}: ${String(status)}.`);
  }

  return { ensureTenant, arnAnchor, associate, teardownTenant, parseStatus, tenantStatus };
}

export type SesTenants = ReturnType<typeof createTenants>;
