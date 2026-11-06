import { createSign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SNS_CERTIFICATE, SNS_PRIVATE_KEY } from "../fixtures/sns-certificate";
import type { Adapter, OutboundMessage, SetupContext } from "@/lib/providers/adapters/types";
import { DomainUnavailableError } from "@/lib/providers/adapters/types";

const sesSend = vi.fn();
const snsSend = vi.fn();
const eventsSend = vi.fn();

class FakeCommand {
  constructor(public readonly input: Record<string, unknown>) {}
}
function commands(names: string[]): Record<string, unknown> {
  return Object.fromEntries(names.map((name) => [name, { [name]: class extends FakeCommand {} }[name]]));
}
function client(send: (command: FakeCommand) => unknown) {
  return class {
    constructor(public readonly config: Record<string, unknown>) {}
    send(command: FakeCommand) {
      return send(command);
    }
  };
}

vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: client((command) => sesSend(command)),
  ...commands([
    "SendEmailCommand",
    "CreateEmailIdentityCommand",
    "GetEmailIdentityCommand",
    "DeleteEmailIdentityCommand",
    "PutEmailIdentityMailFromAttributesCommand",
    "CreateConfigurationSetCommand",
    "CreateConfigurationSetEventDestinationCommand",
    "DeleteConfigurationSetCommand",
    "GetAccountCommand",
    "CreateTenantCommand",
    "GetTenantCommand",
    "DeleteTenantCommand",
    "CreateTenantResourceAssociationCommand",
    "DeleteTenantResourceAssociationCommand",
    "PutTenantSuppressionAttributesCommand",
    "TagResourceCommand",
  ]),
}));
vi.mock("@aws-sdk/client-sns", () => ({
  SNSClient: client((command) => snsSend(command)),
  ...commands(["CreateTopicCommand", "SubscribeCommand", "ConfirmSubscriptionCommand", "SetTopicAttributesCommand", "DeleteTopicCommand"]),
}));
vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: client((command) => eventsSend(command)),
  ...commands(["PutRuleCommand", "PutTargetsCommand"]),
}));
vi.mock("@aws-sdk/client-sts", () => ({
  STSClient: client(() => Promise.resolve({})),
  ...commands(["GetCallerIdentityCommand"]),
}));

const { buildAdapter, isConfiguredFor } = await import("@/lib/providers/adapters");
const { ACCOUNT_TAG, resetCertificateCache, tenantNameFromArn, TENANT_TAG } = await import("@/lib/providers/adapters/ses");

const REGION = "us-west-2";
const TENANT = "org_abc";
const TENANT_ARN = `arn:aws:ses:${REGION}:111122223333:tenant/${TENANT}/tn-1`;
const STATUS_TOPIC = `arn:aws:sns:${REGION}:111122223333:mail-tenant-status-pac-shared`;
const CERT_URL = `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-1234.pem`;

function provider(settings: Record<string, string>, providerId = "pac_tenant1"): Adapter {
  return buildAdapter("ses", { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", region: REGION }, settings, providerId);
}

const tenant = (extra: Record<string, string> = {}) => provider({ tenantName: TENANT, ...extra });
const shared = () => provider({ sharing: "operator", topicArn: STATUS_TOPIC }, "pac_shared");

function named(command: FakeCommand): string {
  return command.constructor.name;
}
function calls(mock: ReturnType<typeof vi.fn>): FakeCommand[] {
  return mock.mock.calls.map((call) => call[0] as FakeCommand);
}
function sent(name: string, mock = sesSend): FakeCommand[] {
  return calls(mock).filter((command) => named(command) === name);
}
function awsError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function context(): SetupContext & { saved: Record<string, string> } {
  const saved: Record<string, string> = {};
  return {
    saved,
    webhookUrl: "https://mail.example.com/api/webhooks/ses/pac_tenant1",
    save: async (patch) => {
      Object.assign(saved, patch);
    },
  };
}

function outbound(): OutboundMessage {
  return {
    id: "msg_test",
    from: { name: null, address: "ada@example.com" },
    to: ["person@example.net"],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: "Hello",
    html: "<p>Hello</p>",
    text: null,
    headers: {},
    tags: [],
    attachments: [],
  };
}

function statusNotification(event: Record<string, unknown>, topicArn = STATUS_TOPIC) {
  const message: Record<string, string> = {
    Type: "Notification",
    MessageId: "sns-status-1",
    TopicArn: topicArn,
    Message: JSON.stringify(event),
    Timestamp: "2026-09-16T10:00:00.000Z",
  };
  const canonical = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
    .filter((field) => message[field] !== undefined)
    .map((field) => `${field}\n${message[field]}\n`)
    .join("");
  const body = {
    ...message,
    SignatureVersion: "2",
    SigningCertURL: CERT_URL,
    Signature: createSign("RSA-SHA256").update(canonical, "utf8").sign(SNS_PRIVATE_KEY.trim(), "base64"),
  };
  return { rawBody: JSON.stringify(body), headers: {} };
}

function disabledEvent(resource = TENANT_ARN): Record<string, unknown> {
  return {
    "detail-type": "Sending Status Disabled",
    source: "aws.ses",
    resources: [resource],
    detail: { version: "1.0.0", data: { origin: "AWS_MANAGED", record: { status: "DISABLED", cause: "High bounce rate." } } },
  };
}

beforeEach(() => {
  sesSend.mockReset();
  snsSend.mockReset();
  eventsSend.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url) === CERT_URL) return new Response(SNS_CERTIFICATE.trim());
      throw new Error(`unexpected fetch of ${String(url)}`);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetCertificateCache();
});

describe("tenant send", () => {
  it("sends without a tenant from an ordinary provider", async () => {
    sesSend.mockResolvedValue({ MessageId: "ses-1" });

    await provider({ configurationSetName: "mail-events-pac-own" }).send(outbound());

    expect(sent("SendEmailCommand")[0]?.input).not.toHaveProperty("TenantName");
  });
});

describe("tenant setup", () => {
  beforeEach(() => {
    sesSend.mockImplementation(async (command: FakeCommand) => {
      if (named(command) === "CreateTenantCommand") return { TenantArn: TENANT_ARN };
      return {};
    });
    snsSend.mockImplementation(async (command: FakeCommand) =>
      named(command) === "CreateTopicCommand" ? { TopicArn: `arn:aws:sns:${REGION}:111122223333:mail-events-pac-tenant1` } : {},
    );
  });

  it("creates the tenant, then the configuration set, then associates it", async () => {
    const ctx = context();

    const result = await tenant().setup!.configureEvents("", ctx);

    const order = calls(sesSend).map(named);
    expect(order.slice(0, 3)).toEqual([
      "CreateTenantCommand",
      "CreateConfigurationSetCommand",
      "CreateTenantResourceAssociationCommand",
    ]);
    expect(sent("CreateTenantCommand")[0]?.input).toEqual({
      TenantName: TENANT,
      SuppressionAttributes: { SuppressionScope: "TENANT", SuppressedReasons: ["BOUNCE", "COMPLAINT"] },
    });
    expect(sent("CreateTenantResourceAssociationCommand")[0]?.input).toEqual({
      TenantName: TENANT,
      ResourceArn: `arn:aws:ses:${REGION}:111122223333:configuration-set/mail-events-pac-tenant1`,
    });
    expect(result.settings).toMatchObject({ tenantArn: TENANT_ARN, configurationSetAssociated: "true" });
    expect(ctx.saved.tenantArn).toBe(TENANT_ARN);
  });

  it("picks up a tenant an earlier attempt created and reapplies its suppression scope", async () => {
    sesSend.mockImplementation(async (command: FakeCommand) => {
      if (named(command) === "CreateTenantCommand") throw awsError("AlreadyExistsException");
      if (named(command) === "GetTenantCommand") return { Tenant: { TenantArn: TENANT_ARN } };
      if (named(command) === "CreateTenantResourceAssociationCommand") throw awsError("AlreadyExistsException");
      return {};
    });

    const result = await tenant().setup!.configureEvents("", context());

    expect(sent("PutTenantSuppressionAttributesCommand")[0]?.input).toMatchObject({ TenantName: TENANT, SuppressionScope: "TENANT" });
    expect(result.settings.tenantArn).toBe(TENANT_ARN);
  });

  it("isn't configured until the tenant and its association are recorded", () => {
    const base = { tenantName: TENANT, configurationSetName: "cs", topicArn: "t", subscriptionConfirmed: "true" };
    expect(isConfiguredFor("ses", base)).toBe(false);
    expect(isConfiguredFor("ses", { ...base, tenantArn: TENANT_ARN })).toBe(false);
    expect(isConfiguredFor("ses", { ...base, tenantArn: TENANT_ARN, configurationSetAssociated: "true" })).toBe(true);
    expect(isConfiguredFor("ses", { configurationSetName: "cs", topicArn: "t", subscriptionConfirmed: "true" })).toBe(true);
  });

  it("tears down in the order SES allows, and again after a partial teardown", async () => {
    const topicArn = `arn:aws:sns:${REGION}:111122223333:mail-events-pac-tenant1`;
    const provider = tenant({ tenantArn: TENANT_ARN, configurationSetName: "mail-events-pac-tenant1", topicArn });

    await provider.setup!.teardown!();
    expect(calls(sesSend).map(named)).toEqual([
      "DeleteTenantResourceAssociationCommand",
      "DeleteConfigurationSetCommand",
      "DeleteTenantCommand",
    ]);
    expect(sent("DeleteTopicCommand", snsSend)[0]?.input).toEqual({ TopicArn: topicArn });

    sesSend.mockReset();
    sesSend.mockRejectedValue(awsError("NotFoundException"));
    await expect(provider.setup!.teardown!()).resolves.toBeUndefined();
  });

  it("has no teardown on an ordinary provider", () => {
    expect(provider({}).setup?.teardown).toBeUndefined();
  });
});

describe("tenant domains", () => {
  it("tags the identity with the tenant and associates it", async () => {
    sesSend.mockImplementation(async (command: FakeCommand) => {
      if (named(command) === "CreateEmailIdentityCommand") return { DkimAttributes: { Tokens: ["a"] } };
      return {};
    });

    await tenant({ tenantArn: TENANT_ARN }).domain.create("example.com");

    expect(sent("CreateEmailIdentityCommand")[0]?.input.Tags).toEqual([{ Key: TENANT_TAG, Value: TENANT }]);
    expect(sent("CreateTenantResourceAssociationCommand")[0]?.input).toEqual({
      TenantName: TENANT,
      ResourceArn: `arn:aws:ses:${REGION}:111122223333:identity/example.com`,
    });
  });

  it("refuses an identity another tenant holds, before touching it", async () => {
    sesSend.mockImplementation(async (command: FakeCommand) => {
      if (named(command) === "CreateEmailIdentityCommand") throw awsError("AlreadyExistsException");
      if (named(command) === "GetEmailIdentityCommand") return { Tags: [{ Key: TENANT_TAG, Value: "org_someone_else" }] };
      return {};
    });

    await expect(tenant({ tenantArn: TENANT_ARN }).domain.create("example.com")).rejects.toBeInstanceOf(DomainUnavailableError);
    expect(sent("PutEmailIdentityMailFromAttributesCommand")).toHaveLength(0);
    expect(sent("CreateTenantResourceAssociationCommand")).toHaveLength(0);
  });

  it("refuses an untagged identity already on the shared provider", async () => {
    sesSend.mockImplementation(async (command: FakeCommand) => {
      if (named(command) === "CreateEmailIdentityCommand") throw awsError("AlreadyExistsException");
      if (named(command) === "GetEmailIdentityCommand") return {};
      return {};
    });

    await expect(tenant({ tenantArn: TENANT_ARN }).domain.create("example.com")).rejects.toBeInstanceOf(DomainUnavailableError);
  });

  it("resumes its own half-created identity", async () => {
    sesSend.mockImplementation(async (command: FakeCommand) => {
      if (named(command) === "CreateEmailIdentityCommand") throw awsError("AlreadyExistsException");
      if (named(command) === "GetEmailIdentityCommand") {
        return { Tags: [{ Key: TENANT_TAG, Value: TENANT }], DkimAttributes: { Tokens: ["tok"] } };
      }
      return {};
    });

    const created = await tenant({ tenantArn: TENANT_ARN }).domain.create("example.com");

    expect(created.records[0]?.name).toBe("tok._domainkey.example.com");
    expect(sent("CreateTenantResourceAssociationCommand")).toHaveLength(1);
  });

  it("detaches the identity from the tenant before deleting it", async () => {
    sesSend.mockImplementation(async (command: FakeCommand) =>
      named(command) === "GetEmailIdentityCommand" ? { Tags: [{ Key: TENANT_TAG, Value: TENANT }] } : {},
    );

    await tenant({ tenantArn: TENANT_ARN }).domain.remove!("example.com", "example.com");

    expect(calls(sesSend).map(named)).toEqual([
      "GetEmailIdentityCommand",
      "DeleteTenantResourceAssociationCommand",
      "DeleteEmailIdentityCommand",
    ]);
  });

  it.each([
    ["another tenant's", [{ Key: TENANT_TAG, Value: "org_someone_else" }]],
    ["an ordinary provider's", [{ Key: ACCOUNT_TAG, Value: "pac_tenant1" }]],
    ["an untagged", undefined],
  ])("leaves %s identity alone on remove", async (_label, tags) => {
    sesSend.mockImplementation(async (command: FakeCommand) => (named(command) === "GetEmailIdentityCommand" ? { Tags: tags } : {}));

    await tenant({ tenantArn: TENANT_ARN }).domain.remove!("example.com", "example.com");

    expect(sent("DeleteEmailIdentityCommand")).toHaveLength(0);
  });
});

describe("tenant domain adoption", () => {
  /** An identity SES already verified, with no tags: what every identity from before tagging looks like. */
  function untagged(extra: Record<string, unknown> = {}) {
    return {
      VerifiedForSendingStatus: true,
      DkimAttributes: { Status: "SUCCESS", Tokens: ["tok1", "tok2", "tok3"] },
      ...extra,
    };
  }

  it("keeps the identity's DKIM tokens and proposes the records they already have", async () => {
    sesSend.mockImplementation(async (command: FakeCommand) => (named(command) === "GetEmailIdentityCommand" ? untagged() : {}));

    const adopted = await tenant({ tenantArn: TENANT_ARN }).domain.adopt!("example.com");

    expect(adopted.dkimTokens).toEqual(["tok1", "tok2", "tok3"]);
    expect(adopted.records.filter((record) => record.type === "CNAME").map((record) => record.name)).toEqual([
      "tok1._domainkey.example.com",
      "tok2._domainkey.example.com",
      "tok3._domainkey.example.com",
    ]);
    // Rotating a signing key is what would take the domain off the air.
    expect(calls(sesSend).map(named)).not.toContain("CreateEmailIdentityCommand");
  });

  it("refuses another provider's identity before touching it", async () => {
    const Tags = [{ Key: ACCOUNT_TAG, Value: "pac_other" }];
    sesSend.mockImplementation(async (command: FakeCommand) => (named(command) === "GetEmailIdentityCommand" ? untagged({ Tags }) : {}));

    await expect(tenant({ tenantArn: TENANT_ARN }).domain.adopt!("example.com")).rejects.toBeInstanceOf(DomainUnavailableError);
    expect(sent("TagResourceCommand")).toHaveLength(0);
    expect(sent("CreateTenantResourceAssociationCommand")).toHaveLength(0);
    expect(sent("PutEmailIdentityMailFromAttributesCommand")).toHaveLength(0);
  });

  it("sets the MAIL FROM domain only when the identity has none", async () => {
    sesSend.mockImplementation(async (command: FakeCommand) => (named(command) === "GetEmailIdentityCommand" ? untagged() : {}));

    const adopted = await tenant({ tenantArn: TENANT_ARN }).domain.adopt!("example.com");

    expect(sent("PutEmailIdentityMailFromAttributesCommand")[0]?.input).toEqual({
      EmailIdentity: "example.com",
      MailFromDomain: "mail.example.com",
      BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
    });
    expect(adopted.existingMailFromDomain).toBeNull();
  });

  it("re-tags nothing when the identity is already this tenant's", async () => {
    sesSend.mockImplementation(async (command: FakeCommand) =>
      named(command) === "GetEmailIdentityCommand" ? untagged({ Tags: [{ Key: TENANT_TAG, Value: TENANT }] }) : {},
    );

    await tenant({ tenantArn: TENANT_ARN }).domain.adopt!("example.com");

    expect(sent("TagResourceCommand")).toHaveLength(0);
    expect(sent("CreateTenantResourceAssociationCommand")).toHaveLength(1);
  });
});

describe("tenant health", () => {
  it("reads a paused tenant as unhealthy", async () => {
    sesSend.mockResolvedValue({ Tenant: { SendingStatus: "DISABLED" } });
    expect(await tenant().healthCheck()).toEqual({ ok: false, detail: "Sending is paused for this organization." });
    expect(sent("GetAccountCommand")).toHaveLength(0);
  });

  it("reads a reinstated tenant as healthy", async () => {
    sesSend.mockResolvedValue({ Tenant: { SendingStatus: "REINSTATED" } });
    expect((await tenant().healthCheck()).ok).toBe(true);
  });

  it("names the missing permission on an access-denied error, instead of reading it as an outage", async () => {
    sesSend.mockRejectedValue(
      Object.assign(new Error("User: arn:aws:iam::123456789012:user/pouch is not authorized to perform: ses:GetTenant"), {
        name: "AccessDeniedException",
      }),
    );

    expect(await tenant().healthCheck()).toEqual({
      ok: false,
      detail: "Credentials are valid but missing the ses:GetTenant permission.",
    });
  });
});

describe("shared provider", () => {
  beforeEach(() => {
    snsSend.mockImplementation(async (command: FakeCommand) => (named(command) === "CreateTopicCommand" ? { TopicArn: STATUS_TOPIC } : {}));
    eventsSend.mockImplementation(async (command: FakeCommand) =>
      named(command) === "PutRuleCommand" ? { RuleArn: "arn:aws:events:us-west-2:111122223333:rule/mail-tenant-status-pac-shared" } : { FailedEntryCount: 0 },
    );
  });

  it("routes tenant status events from EventBridge to its topic", async () => {
    const result = await provider({ sharing: "operator" }, "pac_shared").setup!.configureEvents("", context());

    const [rule] = sent("PutRuleCommand", eventsSend);
    expect(JSON.parse(String(rule?.input.EventPattern))).toEqual({
      source: ["aws.ses"],
      "detail-type": [
        "Sending Status Enabled",
        "Sending Status Disabled",
        "Advisor Recommendation Status Open",
        "Advisor Recommendation Status Closed",
      ],
    });
    const policy = sent("SetTopicAttributesCommand", snsSend).find((command) => command.input.AttributeName === "Policy");
    expect(JSON.parse(String(policy?.input.AttributeValue)).Statement[0]).toMatchObject({
      Principal: { Service: "events.amazonaws.com" },
      Condition: { ArnEquals: { "aws:SourceArn": "arn:aws:events:us-west-2:111122223333:rule/mail-tenant-status-pac-shared" } },
    });
    expect(sent("PutTargetsCommand", eventsSend)[0]?.input).toEqual({
      Rule: "mail-tenant-status-pac-shared",
      Targets: [{ Id: "tenant-status", Arn: STATUS_TOPIC }],
    });
    expect(result.settings).toEqual({ topicArn: STATUS_TOPIC, eventRuleArn: expect.stringContaining(":rule/") });
    expect(sent("CreateConfigurationSetCommand")).toHaveLength(0);
  });

  it("fails setup when EventBridge refuses the target", async () => {
    eventsSend.mockImplementation(async (command: FakeCommand) =>
      named(command) === "PutRuleCommand"
        ? { RuleArn: "arn:aws:events:us-west-2:111122223333:rule/x" }
        : { FailedEntryCount: 1, FailedEntries: [{ ErrorMessage: "Access denied" }] },
    );

    await expect(provider({ sharing: "operator" }, "pac_shared").setup!.configureEvents("", context())).rejects.toThrow("Access denied");
  });

  it("parses tenant status from a signed notification", async () => {
    const provider = shared();
    const request = statusNotification(disabledEvent());

    expect(await provider.events.verify(request)).toBe(true);
    expect(provider.events.parse(request)).toEqual([]);
    expect(provider.tenants!.parseStatus(request)).toEqual([
      {
        kind: "sending_disabled",
        tenantRef: TENANT_ARN,
        tenantName: TENANT,
        detail: expect.objectContaining({ data: expect.objectContaining({ origin: "AWS_MANAGED" }) }),
      },
    ]);
  });

  it("ignores status from another topic or another source", () => {
    const provider = shared();
    expect(provider.tenants!.parseStatus(statusNotification(disabledEvent(), `${STATUS_TOPIC}-other`))).toEqual([]);
    expect(provider.tenants!.parseStatus(statusNotification({ ...disabledEvent(), source: "aws.other" }))).toEqual([]);
  });

  it("reads a tenant's sending status", async () => {
    sesSend.mockResolvedValueOnce({ Tenant: { SendingStatus: "DISABLED" } });
    sesSend.mockResolvedValueOnce({ Tenant: { SendingStatus: "REINSTATED" } });
    sesSend.mockRejectedValueOnce(awsError("NotFoundException"));

    expect(await shared().tenants!.status(TENANT)).toBe("disabled");
    expect(await shared().tenants!.status(TENANT)).toBe("enabled");
    expect(await shared().tenants!.status(TENANT)).toBeNull();
  });

  it("throws when the status read fails, so the caller can't mistake it for an answer", async () => {
    sesSend.mockRejectedValueOnce(awsError("AccessDeniedException"));
    await expect(shared().tenants!.status(TENANT)).rejects.toThrow();

    sesSend.mockResolvedValueOnce({ Tenant: {} });
    await expect(shared().tenants!.status(TENANT)).rejects.toThrow("no known sending status");
  });

  it("is absent from an ordinary provider and a tenant", () => {
    expect(provider({}).tenants).toBeUndefined();
    expect(tenant().tenants).toBeUndefined();
  });
});

describe("tenantNameFromArn", () => {
  it("reads the name from a named tenant ARN only", () => {
    expect(tenantNameFromArn(TENANT_ARN)).toBe(TENANT);
    expect(tenantNameFromArn("arn:aws:ses:us-east-1:111122223333:tenant/tn-1")).toBeNull();
    expect(tenantNameFromArn("arn:aws:ses:us-east-1:111122223333:identity/example.com")).toBeNull();
  });
});
