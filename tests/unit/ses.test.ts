import { createSign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SNS_CERTIFICATE, SNS_PRIVATE_KEY } from "../fixtures/sns-certificate";
import type { Adapter, OutboundMessage, SignedRequest } from "@/lib/providers/adapters/types";

const sesSend = vi.fn();
const snsSend = vi.fn();

/** Stands in for an AWS SDK command: carries its input and its class name. */
class FakeCommand {
  constructor(public readonly input: Record<string, unknown>) {}
}
function commands(names: string[]): Record<string, unknown> {
  return Object.fromEntries(
    names.map((name) => [name, { [name]: class extends FakeCommand {} }[name]]),
  );
}

vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: class {
    constructor(public readonly config: Record<string, unknown>) {}
    send(command: FakeCommand) {
      return sesSend(command);
    }
  },
  ...commands([
    "SendEmailCommand",
    "CreateEmailIdentityCommand",
    "GetEmailIdentityCommand",
    "DeleteEmailIdentityCommand",
    "PutEmailIdentityMailFromAttributesCommand",
    "CreateConfigurationSetCommand",
    "CreateConfigurationSetEventDestinationCommand",
    "GetAccountCommand",
    "ListRecommendationsCommand",
    "TagResourceCommand",
  ]),
}));

const cloudWatchSend = vi.fn();

vi.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: class {
    constructor(public readonly config: Record<string, unknown>) {}
    send(command: FakeCommand) {
      return cloudWatchSend(command);
    }
  },
  ...commands(["GetMetricDataCommand"]),
}));

vi.mock("@aws-sdk/client-sns", () => ({
  SNSClient: class {
    constructor(public readonly config: Record<string, unknown>) {}
    send(command: FakeCommand) {
      return snsSend(command);
    }
  },
  ...commands(["CreateTopicCommand", "SubscribeCommand", "ConfirmSubscriptionCommand", "SetTopicAttributesCommand"]),
}));

const stsSend = vi.fn();

vi.mock("@aws-sdk/client-sts", () => ({
  STSClient: class {
    constructor(public readonly config: Record<string, unknown>) {}
    send(command: FakeCommand) {
      return stsSend(command);
    }
  },
  ...commands(["GetCallerIdentityCommand"]),
}));

const { buildAdapter } = await import("@/lib/providers/adapters");
const { ACCOUNT_TAG, API_RETRY, CERTIFICATE_TIMEOUT_MS, MAX_CACHED_CERTIFICATES, TENANT_TAG, principalArn, resetCertificateCache, cachedCertificateCount } =
  await import("@/lib/providers/adapters/ses");
const { DomainNotAtProviderError, DomainUnavailableError } = await import("@/lib/providers/adapters/types");

const REGION = "us-west-2";
const TOPIC_ARN = "arn:aws:sns:us-west-2:123456789012:mail-events-example-com";
const CERT_URL = "https://sns.us-west-2.amazonaws.com/SimpleNotificationService-1234.pem";

function ses(
  settings: Record<string, string> = { topicArn: TOPIC_ARN, configurationSetName: "mail-events-example-com" },
  providerId = "pac_provider1",
): Adapter {
  return buildAdapter(
    "ses",
    { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", region: REGION },
    settings,
    providerId,
  );
}

function outbound(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    id: "msg_test",
    from: { name: "Ada", address: "ada@example.com" },
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
    ...overrides,
  };
}

function named(command: FakeCommand): string {
  return command.constructor.name;
}

function awsError(name: string, message: string, status: number): Error {
  const error = new Error(message);
  error.name = name;
  (error as unknown as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode: status };
  return error;
}

/** Signs an SNS envelope the way SNS does, over the canonical field list for its type. */
function signed(message: Record<string, string>, signatureVersion = "2"): Record<string, string> {
  const fields =
    message.Type === "Notification"
      ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
      : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  const canonical = fields
    .filter((field) => message[field] !== undefined)
    .map((field) => `${field}\n${message[field]}\n`)
    .join("");
  const algorithm = signatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256";
  return {
    ...message,
    SignatureVersion: signatureVersion,
    SigningCertURL: CERT_URL,
    Signature: createSign(algorithm).update(canonical, "utf8").sign(SNS_PRIVATE_KEY.trim(), "base64"),
  };
}

function notification(
  event: Record<string, unknown>,
  overrides: Record<string, string> = {},
  signatureVersion = "2",
): SignedRequest {
  const body = signed(
    {
      Type: "Notification",
      MessageId: "sns-message-1",
      TopicArn: TOPIC_ARN,
      Message: JSON.stringify(event),
      Timestamp: "2026-09-08T10:00:00.000Z",
      ...overrides,
    },
    signatureVersion,
  );
  return { rawBody: JSON.stringify(body), headers: { "x-amz-sns-message-type": "Notification" } };
}

function mail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: "0100018f-aws-message-id",
    timestamp: "2026-09-08T10:00:00.000Z",
    destination: ["person@example.net"],
    ...overrides,
  };
}

const apiRetryDefaults = { ...API_RETRY };

beforeEach(() => {
  API_RETRY.baseMs = 1;
  sesSend.mockReset();
  snsSend.mockReset();
  stsSend.mockReset();
  cloudWatchSend.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).startsWith(`https://sns.${REGION}.amazonaws.com/`)) return new Response(SNS_CERTIFICATE.trim());
      throw new Error(`unexpected fetch of ${String(url)}`);
    }),
  );
});
afterEach(() => {
  Object.assign(API_RETRY, apiRetryDefaults);
  vi.unstubAllGlobals();
  resetCertificateCache();
});

describe("ses send", () => {
  it("sends raw MIME through the provider's configuration set and returns the provider id", async () => {
    sesSend.mockResolvedValue({ MessageId: "0100018f-aws-message-id" });

    const receipt = await ses().send(outbound({ cc: ["cc@example.net"], bcc: ["bcc@example.net"] }));

    expect(sesSend).toHaveBeenCalledTimes(1);
    const command = sesSend.mock.calls[0]?.[0] as FakeCommand;
    expect(named(command)).toBe("SendEmailCommand");
    expect(command.input.ConfigurationSetName).toBe("mail-events-example-com");
    expect(command.input.Destination).toEqual({
      ToAddresses: ["person@example.net"],
      CcAddresses: ["cc@example.net"],
      BccAddresses: ["bcc@example.net"],
    });

    const raw = Buffer.from(
      (command.input.Content as { Raw: { Data: Uint8Array } }).Raw.Data,
    ).toString("utf8");
    expect(raw).toContain("From: Ada <ada@example.com>");
    expect(raw).toContain("To: person@example.net");
    expect(raw).toContain("Cc: cc@example.net");
    // Bcc travels in the destination, never in the body every recipient can read.
    expect(raw).not.toContain("bcc@example.net");

    if (!receipt.successful) throw new Error("expected a successful receipt");
    expect(receipt.providerMessageId).toBe("0100018f-aws-message-id");
  });

  it("carries custom headers and attachments in the MIME body", async () => {
    sesSend.mockResolvedValue({ MessageId: "id" });

    await ses().send(
      outbound({
        headers: { "X-Entity-Ref": "order-42" },
        attachments: [{ filename: "receipt.txt", content: Buffer.from("hi").toString("base64"), contentType: "text/plain" }],
      }),
    );

    const raw = Buffer.from(
      ((sesSend.mock.calls[0]?.[0] as FakeCommand).input.Content as { Raw: { Data: Uint8Array } }).Raw.Data,
    ).toString("utf8");
    expect(raw).toContain("X-Entity-Ref: order-42");
    expect(raw).toContain("multipart/mixed");
    expect(raw).toContain('filename="receipt.txt"');
  });

  it("asks for provider backoff when SES throttles, with its retry hint", async () => {
    sesSend.mockRejectedValue(awsError("ThrottlingException", "Maximum sending rate exceeded.", 429));

    const receipt = await ses().send(outbound());

    if (receipt.successful) throw new Error("expected a failed receipt");
    expect(receipt.failure).toBe("backoff");
    expect(receipt.errors).toEqual(["Maximum sending rate exceeded."]);
    expect(receipt.retryAfterSeconds).toBeGreaterThan(0);
    expect(receipt.accountWide).toBe(true);
  });

  it("backs off 10 minutes on the daily quota and a minute on the per-second rate", async () => {
    sesSend.mockRejectedValueOnce(awsError("ThrottlingException", "Throttling – Daily message quota exceeded.", 400));
    const daily = await ses().send(outbound());
    sesSend.mockRejectedValueOnce(awsError("ThrottlingException", "Throttling – Maximum sending rate exceeded.", 400));
    const rate = await ses().send(outbound());

    if (daily.successful || rate.successful) throw new Error("expected failed receipts");
    expect(daily).toMatchObject({ failure: "backoff", retryAfterSeconds: 600, accountWide: true });
    expect(rate).toMatchObject({ failure: "backoff", retryAfterSeconds: 60, accountWide: true });
  });

  it("backs the provider off when sending is paused rather than failing the message", async () => {
    sesSend.mockRejectedValue(awsError("SendingPausedException", "Account-level sending is paused.", 400));

    const receipt = await ses().send(outbound());

    if (receipt.successful) throw new Error("expected a failed receipt");
    expect(receipt.failure).toBe("backoff");
    expect(receipt.accountWide).toBeFalsy();
  });

  it("retries a 5xx and fails a 400 for good", async () => {
    sesSend.mockRejectedValueOnce(awsError("InternalServiceError", "Internal error.", 500));
    const transient = await ses().send(outbound());
    sesSend.mockRejectedValueOnce(awsError("BadRequestException", "Email address is not verified.", 400));
    const permanent = await ses().send(outbound());

    if (transient.successful || permanent.successful) throw new Error("expected failed receipts");
    expect(transient.failure).toBe("transient");
    expect(permanent.failure).toBe("permanent");
    expect(permanent.errors).toEqual(["Email address is not verified."]);
  });
});

describe("ses health check", () => {
  it("is ok when the provider is reachable and sending", async () => {
    sesSend.mockResolvedValue({ SendingEnabled: true });

    expect(await ses().healthCheck()).toEqual({ ok: true, detail: null });
  });

  it("reports a disabled provider with the enforcement status, not a raw error", async () => {
    sesSend.mockResolvedValue({ SendingEnabled: false, EnforcementStatus: "PROBATION" });

    const result = await ses().healthCheck();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("PROBATION");
  });

  it("categorizes rejected credentials without echoing the provider's own message", async () => {
    sesSend.mockRejectedValue(awsError("UnrecognizedClientException", "The security token included in the request is invalid.", 403));

    expect(await ses().healthCheck()).toEqual({ ok: false, detail: "Credentials were rejected." });
  });

  it("reports a probe that stays throttled as throttled, not as a failure, after retrying it", async () => {
    sesSend.mockRejectedValue(awsError("TooManyRequestsException", "Too many requests.", 429));

    expect(await ses().healthCheck()).toEqual({ ok: null, detail: "Rate limited by the provider.", throttled: true });
    expect(sesSend).toHaveBeenCalledTimes(API_RETRY.attempts);
  });

  it("answers once a throttled probe gets through", async () => {
    sesSend.mockRejectedValueOnce(awsError("ThrottlingException", "Rate exceeded.", 400)).mockResolvedValue({ SendingEnabled: true });

    expect(await ses().healthCheck()).toEqual({ ok: true, detail: null });
    expect(sesSend).toHaveBeenCalledTimes(2);
  });

  it("doesn't read a resource limit as a throttle", async () => {
    sesSend.mockRejectedValue(awsError("LimitExceededException", "There are too many instances of the specified resource type.", 400));

    expect(await ses().healthCheck()).toEqual({ ok: false, detail: "Provider unreachable or returned an error." });
    expect(sesSend).toHaveBeenCalledTimes(1);
  });

  it("retries an outage on a non-send call, and never retries a send itself", async () => {
    sesSend.mockRejectedValueOnce(awsError("InternalFailure", "Internal error.", 500)).mockResolvedValueOnce({ SendingEnabled: true });
    expect(await ses().healthCheck()).toEqual({ ok: true, detail: null });

    sesSend.mockReset();
    sesSend.mockRejectedValue(awsError("TooManyRequestsException", "Too many requests.", 429));
    await ses().send(outbound());
    expect(sesSend).toHaveBeenCalledTimes(1);
  });

  it("names the missing permission on an access-denied error, instead of reading it as an outage", async () => {
    sesSend.mockRejectedValue(
      awsError(
        "AccessDeniedException",
        "User: arn:aws:iam::123456789012:user/pouch is not authorized to perform: ses:GetAccount on resource: * because no identity-based policy allows the ses:GetAccount action",
        400,
      ),
    );

    expect(await ses().healthCheck()).toEqual({
      ok: false,
      detail: "Credentials are valid but missing the ses:GetAccount permission.",
    });
  });

  it("falls back to an unreachable verdict for anything else", async () => {
    sesSend.mockRejectedValue(awsError("ServiceUnavailableException", "Service is down.", 503));

    expect(await ses().healthCheck()).toEqual({ ok: false, detail: "Provider unreachable or returned an error." });
  });
});

describe("ses quota", () => {
  it("reads the quota and enforcement status from the provider", async () => {
    sesSend.mockResolvedValue({
      SendingEnabled: true,
      EnforcementStatus: "HEALTHY",
      SendQuota: { Max24HourSend: 50_000, MaxSendRate: 14, SentLast24Hours: 4 },
    });

    expect(await ses().quota?.()).toEqual({ max24HourSend: 50_000, maxSendRate: 14, sentLast24Hours: 4, enforcementStatus: "HEALTHY" });
    expect(named(sesSend.mock.calls[0]?.[0] as FakeCommand)).toBe("GetAccountCommand");
  });

  it("answers null rather than throwing when the call fails", async () => {
    sesSend.mockRejectedValue(awsError("ThrottlingException", "Rate exceeded.", 429));

    expect(await ses().quota?.()).toBeNull();
  });
});

describe("ses reputation rates", () => {
  it("reads the latest bounce and complaint rates from CloudWatch", async () => {
    const at = new Date("2026-09-16T10:00:00Z");
    cloudWatchSend.mockResolvedValue({
      MetricDataResults: [
        { Id: "bounce", Values: [0.021, 0.01], Timestamps: [at, new Date("2026-09-16T09:00:00Z")] },
        { Id: "complaint", Values: [0.0002], Timestamps: [new Date("2026-09-16T08:00:00Z")] },
      ],
    });

    expect(await ses().reputationRates?.()).toEqual({ state: "ok", value: { bounceRate: 0.021, complaintRate: 0.0002, at } });
    const input = (cloudWatchSend.mock.calls[0]?.[0] as FakeCommand).input as { MetricDataQueries: { MetricStat: { Metric: unknown } }[] };
    expect(input.MetricDataQueries.map((query) => query.MetricStat.Metric)).toEqual([
      { Namespace: "AWS/SES", MetricName: "Reputation.BounceRate" },
      { Namespace: "AWS/SES", MetricName: "Reputation.ComplaintRate" },
    ]);
  });

  it("reads null rates when AWS published nothing in the window", async () => {
    cloudWatchSend.mockResolvedValue({ MetricDataResults: [{ Id: "bounce", Values: [], Timestamps: [] }] });

    expect(await ses().reputationRates?.()).toEqual({ state: "ok", value: { bounceRate: null, complaintRate: null, at: null } });
  });

  it("names the missing permission instead of failing when CloudWatch is denied", async () => {
    cloudWatchSend.mockRejectedValue(
      awsError("AccessDenied", "User: arn:aws:iam::210987654321:user/pouch is not authorized to perform: cloudwatch:GetMetricData", 403),
    );

    expect(await ses().reputationRates?.()).toEqual({ state: "denied", permission: "cloudwatch:GetMetricData" });
  });

  it("reads a denial reported under another error name as denied", async () => {
    cloudWatchSend.mockRejectedValue(awsError("AccessDeniedException", "not authorized", 403));

    expect((await ses().reputationRates?.())?.state).toBe("denied");
  });

  it("reports anything else as failed", async () => {
    cloudWatchSend.mockRejectedValue(awsError("InternalServiceFault", "boom", 500));

    expect(await ses().reputationRates?.()).toEqual({ state: "failed" });
  });
});

describe("ses tenant findings and counts", () => {
  const shared = () => ses({ sharing: "operator", topicArn: TOPIC_ARN, eventRuleArn: "arn:rule" }, "pac_shared");
  const tenantArn = "arn:aws:ses:us-west-2:123456789012:tenant/org_a/tn-123";

  it("lists open tenant findings across pages, pacing each page after the first", async () => {
    sesSend
      .mockResolvedValueOnce({
        Recommendations: [
          { ResourceArn: tenantArn, Type: "BOUNCE", Impact: "HIGH", Description: "Bounces.", CreatedTimestamp: new Date("2026-09-15T00:00:00Z") },
          { ResourceArn: "arn:aws:ses:us-west-2:123456789012:identity/example.com", Type: "DKIM", Impact: "LOW" },
        ],
        NextToken: "page-2",
      })
      .mockResolvedValueOnce({ Recommendations: [{ ResourceArn: tenantArn, Type: "COMPLAINT", Impact: "LOW" }] });
    const spacing = vi.fn(async () => {});

    const listed = await shared().tenants?.findings?.(5, spacing);

    expect(listed?.complete).toBe(true);
    expect(listed?.findings).toEqual([
      { tenantRef: tenantArn, tenantName: "org_a", type: "BOUNCE", impact: "HIGH", description: "Bounces.", openedAt: new Date("2026-09-15T00:00:00Z") },
      { tenantRef: tenantArn, tenantName: "org_a", type: "COMPLAINT", impact: "LOW", description: null, openedAt: null },
    ]);
    expect(spacing).toHaveBeenCalledTimes(1);
    const inputs = sesSend.mock.calls.map(([command]) => (command as FakeCommand).input);
    expect(inputs[0]).toMatchObject({ Filter: { STATUS: "OPEN" } });
    expect(inputs[1]).toMatchObject({ NextToken: "page-2" });
  });

  it("stops at the page limit and says the list is incomplete", async () => {
    sesSend.mockResolvedValue({ Recommendations: [], NextToken: "more" });

    const listed = await shared().tenants?.findings?.(2, async () => {});

    expect(listed).toEqual({ findings: [], complete: false });
    expect(sesSend).toHaveBeenCalledTimes(2);
  });

  it("answers null when the list can't be read", async () => {
    sesSend.mockRejectedValue(awsError("AccessDeniedException", "not authorized to perform: ses:ListRecommendations", 403));

    expect(await shared().tenants?.findings?.(2, async () => {})).toBeNull();
  });

  it("sums a tenant's sends, bounces and complaints by its id and name", async () => {
    cloudWatchSend.mockResolvedValue({
      MetricDataResults: [
        { Id: "sends", Values: [100, 20] },
        { Id: "bounces", Values: [3] },
        { Id: "complaints", Values: [] },
      ],
    });

    expect(await shared().tenants?.volume?.(tenantArn, 7)).toEqual({ state: "ok", value: { sends: 120, bounces: 3, complaints: 0 } });
    const input = (cloudWatchSend.mock.calls[0]?.[0] as FakeCommand).input as {
      MetricDataQueries: { MetricStat: { Metric: { MetricName: string; Dimensions: unknown } } }[];
    };
    expect(input.MetricDataQueries[0]?.MetricStat.Metric).toEqual({
      Namespace: "AWS/SES",
      MetricName: "Sends",
      Dimensions: [
        { Name: "TenantId", Value: "tn-123" },
        { Name: "TenantName", Value: "org_a" },
      ],
    });
  });

  it("reports a denied tenant read as denied", async () => {
    cloudWatchSend.mockRejectedValue(awsError("AccessDenied", "not authorized", 403));

    expect(await shared().tenants?.volume?.(tenantArn, 7)).toEqual({ state: "denied", permission: "cloudwatch:GetMetricData" });
  });
});

describe("ses conversion principal", () => {
  it("checks an IAM user as itself", () => {
    expect(principalArn("arn:aws:iam::210987654321:user/pouch")).toBe("arn:aws:iam::210987654321:user/pouch");
  });

  it("checks an assumed role as the role", () => {
    expect(principalArn("arn:aws:sts::210987654321:assumed-role/pouch/session-1")).toBe("arn:aws:iam::210987654321:role/pouch");
  });

  it("skips the check for the root user", () => {
    expect(principalArn("arn:aws:iam::210987654321:root")).toBeNull();
  });
});

describe("ses identity", () => {
  it("returns the AWS account id from STS", async () => {
    stsSend.mockResolvedValue({ Account: "210987654321", Arn: "arn:aws:iam::210987654321:user/pouch", UserId: "AID..." });

    expect(await ses().identity!()).toBe("210987654321");
  });

  it("reads null when STS answers without a provider id", async () => {
    stsSend.mockResolvedValue({});

    expect(await ses().identity!()).toBeNull();
  });

  it("reads null, not a thrown error, when the call fails", async () => {
    stsSend.mockRejectedValue(awsError("UnrecognizedClientException", "The security token included in the request is invalid.", 403));

    expect(await ses().identity!()).toBeNull();
  });
});

describe("ses domains", () => {
  it("creates an identity with Easy DKIM and returns the records the domain needs", async () => {
    sesSend.mockImplementation(async (command: FakeCommand) => {
      if (named(command) === "CreateEmailIdentityCommand") {
        return { DkimAttributes: { Tokens: ["tokenone", "tokentwo", "tokenthree"], Status: "PENDING" } };
      }
      return {};
    });

    const created = await ses().domain.create("example.com");

    expect(created.providerDomainId).toBe("example.com");
    const cnames = created.records.filter((record) => record.type === "CNAME");
    expect(cnames).toHaveLength(3);
    expect(cnames[0]).toEqual({
      type: "CNAME",
      name: "tokenone._domainkey.example.com",
      value: "tokenone.dkim.amazonses.com",
      required: true,
    });
    const mx = created.records.find((record) => record.type === "MX");
    expect(mx?.name).toBe("mail.example.com");
    expect(mx?.value).toBe(`feedback-smtp.${REGION}.amazonses.com`);
    expect(mx?.priority).toBe(10);
    const spf = created.records.find((record) => record.type === "TXT" && record.name === "mail.example.com");
    expect(spf?.value).toBe("v=spf1 include:amazonses.com ~all");
    // Domain fails to verify without DKIM; MAIL FROM's MX and TXT don't gate it.
    expect(cnames.every((record) => record.required === true)).toBe(true);
    expect(mx?.required).toBe(false);
    expect(spf?.required).toBe(false);

    const sent = sesSend.mock.calls.map(([command]) => named(command as FakeCommand));
    expect(sent).toContain("CreateEmailIdentityCommand");
    expect(sent).toContain("PutEmailIdentityMailFromAttributesCommand");
  });

  it("reads the tokens off an identity SES already holds, so a failed first attempt can be retried", async () => {
    sesSend.mockImplementation(async (command: FakeCommand) => {
      if (named(command) === "CreateEmailIdentityCommand") {
        throw awsError("AlreadyExistsException", "Email identity already exists.", 400);
      }
      if (named(command) === "GetEmailIdentityCommand") {
        return {
          Tags: [{ Key: ACCOUNT_TAG, Value: "pac_provider1" }],
          DkimAttributes: { Tokens: ["tokenone", "tokentwo", "tokenthree"], Status: "SUCCESS" },
        };
      }
      return {};
    });

    const created = await ses().domain.create("example.com");

    expect(created.providerDomainId).toBe("example.com");
    expect(created.records.filter((record) => record.type === "CNAME")).toHaveLength(3);
    const sent = sesSend.mock.calls.map(([command]) => named(command as FakeCommand));
    expect(sent).toContain("GetEmailIdentityCommand");
  });

  it("tags a new identity with the provider that created it", async () => {
    sesSend.mockImplementation(async (command: FakeCommand) =>
      named(command) === "CreateEmailIdentityCommand" ? { DkimAttributes: { Tokens: ["a"] } } : {},
    );

    await ses().domain.create("example.com");

    const create = sesSend.mock.calls.map(([command]) => command as FakeCommand).find((command) => named(command) === "CreateEmailIdentityCommand");
    expect(create?.input.Tags).toEqual([{ Key: ACCOUNT_TAG, Value: "pac_provider1" }]);
  });

  it.each([
    ["another provider's", [{ Key: ACCOUNT_TAG, Value: "pac_other" }]],
    ["a tenant's", [{ Key: TENANT_TAG, Value: "org_someone" }]],
    ["an untagged", undefined],
  ])("refuses %s existing identity before touching it", async (_label, tags) => {
    sesSend.mockImplementation(async (command: FakeCommand) => {
      if (named(command) === "CreateEmailIdentityCommand") throw awsError("AlreadyExistsException", "exists", 400);
      if (named(command) === "GetEmailIdentityCommand") return { Tags: tags, DkimAttributes: { Tokens: ["a"] } };
      return {};
    });

    await expect(ses().domain.create("example.com")).rejects.toBeInstanceOf(DomainUnavailableError);
    const sent = sesSend.mock.calls.map(([command]) => named(command as FakeCommand));
    expect(sent).not.toContain("PutEmailIdentityMailFromAttributesCommand");
  });

  it.each([
    ["its own", [{ Key: ACCOUNT_TAG, Value: "pac_provider1" }]],
    ["a legacy untagged", undefined],
  ])("removes %s identity", async (_label, tags) => {
    sesSend.mockImplementation(async (command: FakeCommand) => (named(command) === "GetEmailIdentityCommand" ? { Tags: tags } : {}));

    await ses().domain.remove!("example.com", "example.com");

    const sent = sesSend.mock.calls.map(([command]) => named(command as FakeCommand));
    expect(sent).toEqual(["GetEmailIdentityCommand", "DeleteEmailIdentityCommand"]);
  });

  it.each([
    ["another provider's", [{ Key: ACCOUNT_TAG, Value: "pac_other" }]],
    ["a tenant's", [{ Key: TENANT_TAG, Value: "org_someone" }]],
  ])("leaves %s identity alone on remove", async (_label, tags) => {
    sesSend.mockImplementation(async (command: FakeCommand) => (named(command) === "GetEmailIdentityCommand" ? { Tags: tags } : {}));

    await ses().domain.remove!("example.com", "example.com");

    const sent = sesSend.mock.calls.map(([command]) => named(command as FakeCommand));
    expect(sent).not.toContain("DeleteEmailIdentityCommand");
  });

  it("treats an identity SES already forgot as removed", async () => {
    sesSend.mockRejectedValue(awsError("NotFoundException", "Email identity does not exist.", 404));

    await expect(ses().domain.remove!("example.com", "example.com")).resolves.toBeUndefined();
  });

  it("surfaces any other failure on remove", async () => {
    sesSend.mockImplementation(async (command: FakeCommand) => {
      if (named(command) === "GetEmailIdentityCommand") return { Tags: [{ Key: ACCOUNT_TAG, Value: "pac_provider1" }] };
      throw awsError("TooManyRequestsException", "Rate exceeded.", 429);
    });

    await expect(ses().domain.remove!("example.com", "example.com")).rejects.toThrow("Rate exceeded.");
  });

  it("reports what's still missing while DKIM is pending", async () => {
    sesSend.mockResolvedValue({
      VerifiedForSendingStatus: false,
      DkimAttributes: { Status: "PENDING", Tokens: ["tokenone", "tokentwo", "tokenthree"] },
      MailFromAttributes: { MailFromDomain: "mail.example.com", MailFromDomainStatus: "PENDING" },
    });

    const status = await ses().domain.verify("example.com", "example.com");

    expect(status.verified).toBe(false);
    expect(status.missing.filter((record) => record.type === "CNAME")).toHaveLength(3);
    expect(status.missing.some((record) => record.type === "MX")).toBe(true);
  });

  it("reports a verified domain with nothing missing", async () => {
    sesSend.mockResolvedValue({
      VerifiedForSendingStatus: true,
      DkimAttributes: { Status: "SUCCESS", Tokens: ["tokenone", "tokentwo", "tokenthree"] },
      MailFromAttributes: { MailFromDomain: "mail.example.com", MailFromDomainStatus: "SUCCESS" },
    });

    const status = await ses().domain.verify("example.com", "example.com");

    expect(status.verified).toBe(true);
    expect(status.missing).toEqual([]);
    expect(status.errors).toEqual([]);
  });

  it("names a failed DKIM setup instead of reporting it as merely pending", async () => {
    sesSend.mockResolvedValue({
      VerifiedForSendingStatus: false,
      DkimAttributes: { Status: "FAILED", Tokens: ["tokenone"] },
      MailFromAttributes: { MailFromDomain: "mail.example.com", MailFromDomainStatus: "SUCCESS" },
    });

    const status = await ses().domain.verify("example.com", "example.com");

    expect(status.verified).toBe(false);
    expect(status.errors.join(" ")).toMatch(/FAILED/);
  });

  it("treats a DKIM status SES can't determine as no answer, not as unverified", async () => {
    sesSend.mockResolvedValue({
      VerifiedForSendingStatus: false,
      DkimAttributes: { Status: "TEMPORARY_FAILURE", Tokens: ["tokenone", "tokentwo", "tokenthree"] },
      MailFromAttributes: { MailFromDomain: "mail.example.com", MailFromDomainStatus: "SUCCESS" },
    });

    const status = await ses().domain.verify("example.com", "example.com");

    expect(status.answered).toBe(false);
    expect(status.verified).toBe(false);
  });

  it("treats a domain SES holds back despite SUCCESS DKIM as no answer", async () => {
    sesSend.mockResolvedValue({
      VerifiedForSendingStatus: false,
      DkimAttributes: { Status: "SUCCESS", Tokens: ["tokenone", "tokentwo", "tokenthree"] },
      MailFromAttributes: { MailFromDomain: "mail.example.com", MailFromDomainStatus: "SUCCESS" },
    });

    const status = await ses().domain.verify("example.com", "example.com");

    expect(status.answered).toBe(false);
    expect(status.verified).toBe(false);
  });

  it("answers NOT_STARTED as records the domain still needs", async () => {
    sesSend.mockResolvedValue({
      VerifiedForSendingStatus: false,
      DkimAttributes: { Status: "NOT_STARTED", Tokens: ["tokenone", "tokentwo", "tokenthree"] },
      MailFromAttributes: { MailFromDomain: "mail.example.com", MailFromDomainStatus: "PENDING" },
    });

    const status = await ses().domain.verify("example.com", "example.com");

    expect(status.answered).toBe(true);
    expect(status.verified).toBe(false);
    expect(status.missing.length).toBeGreaterThan(0);
    expect(status.errors).toEqual([]);
  });

  it("names the identity's own MAIL FROM domain in the records it asks for", async () => {
    sesSend.mockResolvedValue({
      VerifiedForSendingStatus: true,
      DkimAttributes: { Status: "SUCCESS", Tokens: ["tokenone"] },
      MailFromAttributes: { MailFromDomain: "bounces.example.com", MailFromDomainStatus: "PENDING" },
    });

    const status = await ses().domain.verify("example.com", "example.com");

    // An adopted identity may carry a MAIL FROM domain Pouch didn't pick.
    expect(status.missing.map((record) => record.name)).toEqual(["bounces.example.com", "bounces.example.com"]);
  });

  it("reports an identity SES doesn't have rather than throwing", async () => {
    sesSend.mockRejectedValue(awsError("NotFoundException", "Email identity does not exist.", 404));

    const status = await ses().domain.verify("example.com", "example.com");

    expect(status.verified).toBe(false);
    expect(status.errors).toEqual(["Email identity does not exist."]);
  });
});

describe("ses domain adoption on an ordinary provider", () => {
  const AWS_ACCOUNT = "210987654321";

  beforeEach(() => {
    stsSend.mockResolvedValue({ Account: AWS_ACCOUNT, Arn: `arn:aws:iam::${AWS_ACCOUNT}:user/pouch` });
  });

  function untagged(extra: Record<string, unknown> = {}) {
    return { VerifiedForSendingStatus: true, DkimAttributes: { Status: "SUCCESS", Tokens: ["tok1", "tok2"] }, ...extra };
  }

  it("tags an untagged identity for the provider, in the AWS account STS names", async () => {
    sesSend.mockImplementation(async (command: FakeCommand) => (named(command) === "GetEmailIdentityCommand" ? untagged() : {}));

    const adopted = await ses().domain.adopt!("example.com");

    const tag = sesSend.mock.calls.map(([command]) => command as FakeCommand).find((command) => named(command) === "TagResourceCommand");
    expect(tag?.input).toEqual({
      ResourceArn: `arn:aws:ses:${REGION}:${AWS_ACCOUNT}:identity/example.com`,
      Tags: [{ Key: ACCOUNT_TAG, Value: "pac_provider1" }],
    });
    expect(adopted.dkimTokens).toEqual(["tok1", "tok2"]);
    expect(sesSend.mock.calls.map(([command]) => named(command as FakeCommand))).not.toContain("CreateEmailIdentityCommand");
  });

  it("refuses an identity another provider tagged", async () => {
    sesSend.mockImplementation(async (command: FakeCommand) =>
      named(command) === "GetEmailIdentityCommand" ? untagged({ Tags: [{ Key: ACCOUNT_TAG, Value: "pac_other" }] }) : {},
    );

    await expect(ses().domain.adopt!("example.com")).rejects.toBeInstanceOf(DomainUnavailableError);
  });

  it("refuses a domain SES has no identity for", async () => {
    sesSend.mockImplementation(async (command: FakeCommand) => {
      if (named(command) === "GetEmailIdentityCommand") throw awsError("NotFoundException", "not there", 404);
      return {};
    });

    await expect(ses().domain.adopt!("example.com")).rejects.toBeInstanceOf(DomainNotAtProviderError);
  });

  it("refuses to adopt when STS can't name the AWS account, rather than guessing one", async () => {
    stsSend.mockResolvedValue({});
    sesSend.mockImplementation(async (command: FakeCommand) => (named(command) === "GetEmailIdentityCommand" ? untagged() : {}));

    await expect(ses().domain.adopt!("example.com")).rejects.toThrow(/AWS account/);
    expect(sesSend.mock.calls.map(([command]) => named(command as FakeCommand))).not.toContain("TagResourceCommand");
  });
});

describe("ses event setup", () => {
  it("creates the configuration set, topic, subscription and delivery-only event destination", async () => {
    sesSend.mockResolvedValue({});
    snsSend.mockImplementation(async (command: FakeCommand) =>
      named(command) === "CreateTopicCommand" ? { TopicArn: TOPIC_ARN } : {},
    );

    const saved: Record<string, string>[] = [];
    const configured = await ses({}).setup!.configureEvents("example.com", {
      webhookUrl: "https://mail.example.com/api/webhooks/ses/pac_1",
      save: async (patch) => {
        saved.push(patch);
      },
    });

    expect(configured.settings.topicArn).toBe(TOPIC_ARN);
    expect(configured.settings.configurationSetName).toBeTruthy();

    const subscribe = snsSend.mock.calls.map(([c]) => c as FakeCommand).find((c) => named(c) === "SubscribeCommand");
    expect(subscribe?.input.Protocol).toBe("https");
    expect(subscribe?.input.Endpoint).toBe("https://mail.example.com/api/webhooks/ses/pac_1");

    const signatureVersion = snsSend.mock.calls
      .map(([c]) => c as FakeCommand)
      .filter((c) => named(c) === "SetTopicAttributesCommand")
      .find((c) => c.input.AttributeName === "SignatureVersion");
    expect(signatureVersion?.input.AttributeValue).toBe("2");

    const destination = sesSend.mock.calls
      .map(([c]) => c as FakeCommand)
      .find((c) => named(c) === "CreateConfigurationSetEventDestinationCommand");
    const types = (destination?.input.EventDestination as { MatchingEventTypes: string[] }).MatchingEventTypes;
    expect(types).toEqual(["SEND", "DELIVERY", "BOUNCE", "COMPLAINT", "REJECT", "DELIVERY_DELAY"]);
    expect(types).not.toContain("OPEN");
    expect(types).not.toContain("CLICK");
  });

  it("names the configuration set and topic after the provider, not the domain that triggered it", async () => {
    sesSend.mockResolvedValue({});
    snsSend.mockImplementation(async (command: FakeCommand) =>
      named(command) === "CreateTopicCommand" ? { TopicArn: TOPIC_ARN } : {},
    );

    const configured = await ses({}, "pac_kj4z").setup!.configureEvents("example.com", {
      webhookUrl: "https://mail.example.com/api/webhooks/ses/pac_kj4z",
      save: async () => {},
    });

    expect(configured.settings.configurationSetName).toBe("mail-events-pac-kj4z");
    const topic = snsSend.mock.calls.map(([c]) => c as FakeCommand).find((c) => named(c) === "CreateTopicCommand");
    expect(topic?.input.Name).toBe("mail-events-pac-kj4z");
    expect(topic?.input.Name).not.toContain("example");
  });

  it("gives two domains on one provider the same topic, so a concurrent setup can't diverge", async () => {
    sesSend.mockResolvedValue({});
    snsSend.mockImplementation(async (command: FakeCommand) =>
      named(command) === "CreateTopicCommand" ? { TopicArn: TOPIC_ARN } : {},
    );

    const context = { webhookUrl: "https://mail.example.com/api/webhooks/ses/pac_kj4z", save: async () => {} };
    const [first, second] = await Promise.all([
      ses({}, "pac_kj4z").setup!.configureEvents("example.com", context),
      ses({}, "pac_kj4z").setup!.configureEvents("example.net", context),
    ]);

    expect(first.settings.configurationSetName).toBe(second.settings.configurationSetName);
    const names = snsSend.mock.calls
      .map(([c]) => c as FakeCommand)
      .filter((c) => named(c) === "CreateTopicCommand")
      .map((c) => c.input.Name);
    expect(new Set(names).size).toBe(1);
  });
});

describe("ses event setup ordering and retries", () => {
  it("persists the topic, sets its policy and signature version, then subscribes", async () => {
    const timeline: string[] = [];
    sesSend.mockImplementation(async () => ({}));
    snsSend.mockImplementation(async (command: FakeCommand) => {
      timeline.push(`${named(command)}:${(command.input as { AttributeName?: string }).AttributeName ?? ""}`);
      return named(command) === "CreateTopicCommand" ? { TopicArn: TOPIC_ARN } : {};
    });

    await ses({}).setup!.configureEvents("example.com", {
      webhookUrl: "https://mail.example.com/api/webhooks/ses/pac_1",
      save: async (patch) => {
        timeline.push(`save:${Object.keys(patch).sort().join(",")}`);
      },
    });

    const saved = timeline.findIndex((entry) => entry.startsWith("save:") && entry.includes("topicArn"));
    const policySet = timeline.indexOf("SetTopicAttributesCommand:Policy");
    const signatureVersionSet = timeline.indexOf("SetTopicAttributesCommand:SignatureVersion");
    const subscribed = timeline.indexOf("SubscribeCommand:");
    expect(saved).toBeGreaterThanOrEqual(0);
    expect(policySet).toBeGreaterThan(timeline.indexOf("CreateTopicCommand:"));
    expect(signatureVersionSet).toBeGreaterThanOrEqual(0);
    expect(subscribed).toBeGreaterThan(saved);
    expect(subscribed).toBeGreaterThan(policySet);
    expect(subscribed).toBeGreaterThan(signatureVersionSet);
  });

  it("lets SES publish to the topic, scoped to the provider that owns it", async () => {
    sesSend.mockResolvedValue({});
    snsSend.mockImplementation(async (command: FakeCommand) =>
      named(command) === "CreateTopicCommand" ? { TopicArn: TOPIC_ARN } : {},
    );

    await ses({}).setup!.configureEvents("example.com", {
      webhookUrl: "https://mail.example.com/api/webhooks/ses/pac_1",
      save: async () => {},
    });

    const attributes = snsSend.mock.calls
      .map(([c]) => c as FakeCommand)
      .find((c) => named(c) === "SetTopicAttributesCommand");
    expect(attributes?.input.TopicArn).toBe(TOPIC_ARN);
    expect(attributes?.input.AttributeName).toBe("Policy");

    const policy = JSON.parse(String(attributes?.input.AttributeValue)) as {
      Statement: { Effect: string; Principal: { Service: string }; Action: string; Resource: string; Condition: unknown }[];
    };
    const statement = policy.Statement[0];
    expect(statement?.Effect).toBe("Allow");
    expect(statement?.Principal.Service).toBe("ses.amazonaws.com");
    expect(statement?.Action).toBe("sns:Publish");
    expect(statement?.Resource).toBe(TOPIC_ARN);
    expect(statement?.Condition).toEqual({ StringEquals: { "AWS:SourceAccount": "123456789012" } });
  });

  it("gives SNS the better part of an hour of retries, so a deploy can't lose a delivery event", async () => {
    sesSend.mockImplementation(async () => ({}));
    snsSend.mockImplementation(async (command: FakeCommand) =>
      named(command) === "CreateTopicCommand" ? { TopicArn: TOPIC_ARN } : {},
    );

    await ses({}).setup!.configureEvents("example.com", {
      webhookUrl: "https://mail.example.com/api/webhooks/ses/pac_1",
      save: async () => {},
    });

    const policySet = snsSend.mock.calls
      .map(([c]) => c as FakeCommand)
      .filter((c) => named(c) === "SetTopicAttributesCommand")
      .find((c) => c.input.AttributeName === "DeliveryPolicy");
    const policy = JSON.parse(String(policySet?.input.AttributeValue)) as {
      http: {
        defaultHealthyRetryPolicy: {
          numRetries: number;
          numMinDelayRetries: number;
          numMaxDelayRetries: number;
          minDelayTarget: number;
          maxDelayTarget: number;
        };
        disableSubscriptionOverrides: boolean;
      };
    };
    const retry = policy.http.defaultHealthyRetryPolicy;
    expect(retry.numRetries).toBeGreaterThanOrEqual(10);
    // SNS refuses a policy whose retries can total over 3600 s, so the tail is minutes, not the
    // hour itself. Anything under a minute is the default that a deploy outlasted.
    expect(retry.maxDelayTarget).toBeGreaterThanOrEqual(300);
    expect(retry.maxDelayTarget).toBeLessThanOrEqual(900);
    // On the topic, not the subscription: re-running setup repairs subscriptions made before this.
    expect(policy.http.disableSubscriptionOverrides).toBe(false);
  });

  it("completes when the configuration set and event destination already exist", async () => {
    sesSend.mockImplementation(async (command: FakeCommand) => {
      if (named(command) === "CreateConfigurationSetCommand") {
        throw awsError("AlreadyExistsException", "Configuration set already exists.", 400);
      }
      if (named(command) === "CreateConfigurationSetEventDestinationCommand") {
        throw awsError("AlreadyExistsException", "Event destination already exists.", 400);
      }
      return {};
    });
    snsSend.mockImplementation(async (command: FakeCommand) =>
      named(command) === "CreateTopicCommand" ? { TopicArn: TOPIC_ARN } : {},
    );

    const configured = await ses({}).setup!.configureEvents("example.com", {
      webhookUrl: "https://mail.example.com/api/webhooks/ses/pac_1",
      save: async () => {},
    });

    expect(configured.settings.topicArn).toBe(TOPIC_ARN);
    expect(configured.settings.configurationSetName).toBeTruthy();
  });

  it("still fails on an error that isn't an existing resource", async () => {
    sesSend.mockRejectedValue(awsError("AccessDeniedException", "Not authorized.", 403));
    snsSend.mockResolvedValue({ TopicArn: TOPIC_ARN });

    await expect(
      ses({}).setup!.configureEvents("example.com", {
        webhookUrl: "https://mail.example.com/api/webhooks/ses/pac_1",
        save: async () => {},
      }),
    ).rejects.toThrow(/Not authorized/);
  });
});

describe("ses setup state", () => {
  it("counts the provider configured only once the subscription is confirmed", () => {
    const isConfigured = ses().setup!.isConfigured;

    expect(isConfigured({})).toBe(false);
    expect(isConfigured({ topicArn: TOPIC_ARN })).toBe(false);
    expect(isConfigured({ topicArn: TOPIC_ARN, configurationSetName: "set" })).toBe(false);
    expect(isConfigured({ topicArn: TOPIC_ARN, configurationSetName: "set", subscriptionConfirmed: "true" })).toBe(true);
  });

  it("counts a provider waiting on a rebuild as unconfigured until setup clears the mark", () => {
    const isConfigured = ses().setup!.isConfigured;
    const done = { topicArn: TOPIC_ARN, configurationSetName: "set", subscriptionConfirmed: "true" };

    expect(isConfigured({ ...done, rebuild: "configuration set" })).toBe(false);
    expect(isConfigured({ ...done, rebuild: "" })).toBe(true);
  });
});

describe("ses event mapping", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["Send", {}, "sent"],
    ["Delivery", { delivery: { timestamp: "2026-09-08T10:00:02.000Z" } }, "delivered"],
    ["DeliveryDelay", { deliveryDelay: { delayType: "MailboxFull" } }, "deferred"],
    [
      "Bounce",
      { bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "person@example.net" }] } },
      "bounced",
    ],
    [
      "Bounce",
      { bounce: { bounceType: "Transient", bounceSubType: "MailboxFull", bouncedRecipients: [{ emailAddress: "person@example.net" }] } },
      "deferred",
    ],
    ["Complaint", { complaint: { complainedRecipients: [{ emailAddress: "person@example.net" }], complaintFeedbackType: "abuse" } }, "complained"],
    ["Reject", { reject: { reason: "Bad content" } }, "failed"],
  ];

  for (const [eventType, extra, expected] of cases) {
    it(`maps ${eventType}${extra.bounce ? ` ${String((extra.bounce as { bounceType: string }).bounceType)}` : ""} to ${expected}`, () => {
      const [event] = ses().events.parse(notification({ eventType, mail: mail(), ...extra }));

      expect(event?.status).toBe(expected);
      expect(event?.providerMessageId).toBe("0100018f-aws-message-id");
      expect(event?.providerEventId).toBe("sns-message-1");
    });
  }

  it("times each event by when it happened, not when the message was sent", () => {
    const sentAt = "2026-09-08T10:00:00.000Z";
    const cases: [Record<string, unknown>, string][] = [
      [
        { eventType: "Delivery", mail: mail({ timestamp: sentAt }), delivery: { timestamp: "2026-09-08T10:00:04.000Z" } },
        "2026-09-08T10:00:04.000Z",
      ],
      [
        {
          eventType: "Bounce",
          mail: mail({ timestamp: sentAt }),
          bounce: { bounceType: "Permanent", timestamp: "2026-09-08T13:00:00.000Z", bouncedRecipients: [] },
        },
        "2026-09-08T13:00:00.000Z",
      ],
      [
        {
          eventType: "Complaint",
          mail: mail({ timestamp: sentAt }),
          complaint: { timestamp: "2026-09-09T08:00:00.000Z", complainedRecipients: [] },
        },
        "2026-09-09T08:00:00.000Z",
      ],
      [
        {
          eventType: "DeliveryDelay",
          mail: mail({ timestamp: sentAt }),
          deliveryDelay: { delayType: "MailboxFull", timestamp: "2026-09-08T10:30:00.000Z" },
        },
        "2026-09-08T10:30:00.000Z",
      ],
    ];

    for (const [payload, expected] of cases) {
      const [event] = ses().events.parse(notification(payload));
      expect(event?.occurredAt.toISOString(), String(payload.eventType)).toBe(expected);
    }
  });

  it("falls back to the send time when the event carries no timestamp of its own", () => {
    const [event] = ses().events.parse(notification({ eventType: "Send", mail: mail() }));

    expect(event?.occurredAt.toISOString()).toBe("2026-09-08T10:00:00.000Z");
  });

  it("carries the bounce diagnostic verbatim and names the bounced recipient", () => {
    const [event] = ses().events.parse(
      notification({
        eventType: "Bounce",
        mail: mail({ destination: ["person@example.net", "other@example.net"] }),
        bounce: {
          bounceType: "Permanent",
          bounceSubType: "General",
          bouncedRecipients: [{ emailAddress: "person@example.net", diagnosticCode: "smtp; 550 5.1.1 user unknown" }],
        },
      }),
    );

    expect(event?.reason).toBe("smtp; 550 5.1.1 user unknown");
    expect(event?.recipients).toEqual(["person@example.net"]);
  });

  it("keeps the bounce type and subtype beside the diagnostic code", () => {
    const [event] = ses().events.parse(
      notification({
        eventType: "Bounce",
        mail: mail(),
        bounce: {
          bounceType: "Permanent",
          bounceSubType: "NoEmail",
          bouncedRecipients: [{ emailAddress: "person@example.net", diagnosticCode: "smtp; 550 5.1.1 user unknown" }],
        },
      }),
    );

    expect(event?.reason).toBe("smtp; 550 5.1.1 user unknown");
    expect(event?.bounceType).toBe("Permanent/NoEmail");
  });

  it("falls back to the bounce type for the reason, and to null when SES sends neither", () => {
    const [typed] = ses().events.parse(
      notification({ eventType: "Bounce", mail: mail(), bounce: { bounceType: "Transient", bounceSubType: "MailboxFull", bouncedRecipients: [] } }),
    );
    expect(typed?.reason).toBe("Transient/MailboxFull");

    const [bare] = ses().events.parse(notification({ eventType: "Bounce", mail: mail(), bounce: { bouncedRecipients: [] } }));
    expect(bare?.reason).toBeNull();
    expect(bare?.bounceType).toBeNull();
  });

  it.each([
    [
      "a bounce that carries no bounced recipients",
      { eventType: "Bounce", bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [] } },
      [],
    ],
    [
      "a complaint that carries no complained recipients",
      { eventType: "Complaint", complaint: { complainedRecipients: [], complaintFeedbackType: "abuse" } },
      [],
    ],
    [
      "a DeliveryDelay, naming the delayed recipient",
      { eventType: "DeliveryDelay", deliveryDelay: { delayType: "MailboxFull", delayedRecipients: [{ emailAddress: "person@example.net" }] } },
      ["person@example.net"],
    ],
    ["a DeliveryDelay that carries no delayed recipients", { eventType: "DeliveryDelay", deliveryDelay: { delayType: "MailboxFull" } }, []],
    [
      "a Delivery, naming the delivered recipient",
      { eventType: "Delivery", delivery: { timestamp: "2026-09-08T10:00:02.000Z", recipients: ["person@example.net"] } },
      ["person@example.net"],
    ],
    ["a Delivery that carries no recipients", { eventType: "Delivery", delivery: { timestamp: "2026-09-08T10:00:02.000Z" } }, []],
  ])("names only the recipients the event carries, never the whole destination: %s", (_name, payload, expected) => {
    const [event] = ses().events.parse(
      notification({ ...payload, mail: mail({ destination: ["person@example.net", "other@example.net"] }) }),
    );

    expect(event?.recipients).toEqual(expected);
  });

  it("ignores an event type it doesn't map, so an open can't become a lifecycle row", () => {
    expect(ses().events.parse(notification({ eventType: "Open", mail: mail() }))).toEqual([]);
  });

  it("ignores a notification whose topic isn't the provider's", () => {
    const foreign = notification({ eventType: "Delivery", mail: mail() }, { TopicArn: "arn:aws:sns:us-west-2:999:other" });

    expect(ses().events.parse(foreign)).toEqual([]);
  });
});

describe("ses event signatures", () => {
  it("accepts a notification SNS actually signed", async () => {
    expect(await ses().events.verify(notification({ eventType: "Delivery", mail: mail() }))).toBe(true);
  });

  it("rejects a genuinely SHA1-signed notification: SignatureVersion 1 is refused outright", async () => {
    expect(await ses().events.verify(notification({ eventType: "Delivery", mail: mail() }, {}, "1"))).toBe(false);
  });

  it("rejects a forged signature", async () => {
    const request = notification({ eventType: "Delivery", mail: mail() });
    const body = JSON.parse(request.rawBody) as Record<string, string>;
    body.Signature = Buffer.from("forged").toString("base64");

    expect(await ses().events.verify({ ...request, rawBody: JSON.stringify(body) })).toBe(false);
  });

  it("rejects a body edited after signing", async () => {
    const request = notification({ eventType: "Delivery", mail: mail() });
    const body = JSON.parse(request.rawBody) as Record<string, string>;
    body.Message = JSON.stringify({ eventType: "Bounce", mail: mail() });

    expect(await ses().events.verify({ ...request, rawBody: JSON.stringify(body) })).toBe(false);
  });

  it("refuses to fetch a signing certificate from a host that isn't SNS in its region", async () => {
    const request = notification({ eventType: "Delivery", mail: mail() });
    const body = JSON.parse(request.rawBody) as Record<string, string>;
    body.SigningCertURL = "https://attacker.example.com/cert.pem";

    expect(await ses().events.verify({ ...request, rawBody: JSON.stringify(body) })).toBe(false);
    expect(fetch).not.toHaveBeenCalledWith("https://attacker.example.com/cert.pem");
  });

  it("refuses a signing certificate served over plain http", async () => {
    const request = notification({ eventType: "Delivery", mail: mail() });
    const body = JSON.parse(request.rawBody) as Record<string, string>;
    body.SigningCertURL = `http://sns.${REGION}.amazonaws.com/cert.pem`;

    expect(await ses().events.verify({ ...request, rawBody: JSON.stringify(body) })).toBe(false);
  });

  it("rejects a genuinely signed notification on a topic that isn't the provider's", async () => {
    const foreign = notification({ eventType: "Delivery", mail: mail() }, { TopicArn: "arn:aws:sns:us-west-2:999:other" });

    expect(await ses().events.verify(foreign)).toBe(false);
  });

  it("rejects everything when the provider has no topic yet", async () => {
    expect(await ses({}).events.verify(notification({ eventType: "Delivery", mail: mail() }))).toBe(false);
  });

  it(
    "gives up on a signing certificate the host never returns",
    async () => {
      vi.useFakeTimers();
      try {
        // Hangs unless the fetch is aborted, so this can only pass with a real timeout.
        vi.stubGlobal(
          "fetch",
          vi.fn(
            (_url: string, init?: RequestInit) =>
              new Promise((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
              }),
          ),
        );

        const pending = ses().events.verify(notification({ eventType: "Delivery", mail: mail() }));
        await vi.advanceTimersByTimeAsync(CERTIFICATE_TIMEOUT_MS ?? 10_000);

        expect(await pending).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
    3000,
  );

  it("rejects an unsigned body", async () => {
    expect(await ses().events.verify({ rawBody: JSON.stringify({ Type: "Notification" }), headers: {} })).toBe(false);
  });

  it("rejects a body that isn't JSON", async () => {
    expect(await ses().events.verify({ rawBody: "not json", headers: {} })).toBe(false);
  });
});

describe("ses subscription confirmation", () => {
  function confirmation(topicArn = TOPIC_ARN): SignedRequest {
    const body = signed({
      Type: "SubscriptionConfirmation",
      MessageId: "sns-confirm-1",
      TopicArn: topicArn,
      Token: "confirm-token",
      Message: "You have chosen to subscribe to this topic.",
      SubscribeURL: `https://sns.${REGION}.amazonaws.com/?Action=ConfirmSubscription`,
      Timestamp: "2026-09-08T10:00:00.000Z",
    });
    return { rawBody: JSON.stringify(body), headers: { "x-amz-sns-message-type": "SubscriptionConfirmation" } };
  }

  it("verifies a subscription confirmation the same way as a notification", async () => {
    expect(await ses().events.verify(confirmation())).toBe(true);
  });

  it("confirms a subscription on the provider's own topic and reports it for storing", async () => {
    snsSend.mockResolvedValue({ SubscriptionArn: `${TOPIC_ARN}:sub` });

    const outcome = await ses().events.control!(confirmation());

    expect(outcome.handled).toBe(true);
    const command = snsSend.mock.calls[0]?.[0] as FakeCommand;
    expect(named(command)).toBe("ConfirmSubscriptionCommand");
    expect(command.input).toEqual({ TopicArn: TOPIC_ARN, Token: "confirm-token" });
    expect(outcome.settings).toEqual({ subscriptionConfirmed: "true" });
  });

  it("refuses to confirm a subscription to a topic the provider doesn't own", async () => {
    const outcome = await ses().events.control!(confirmation("arn:aws:sns:us-west-2:999:attacker-topic"));

    expect(outcome.handled).toBe(true);
    expect(snsSend).not.toHaveBeenCalled();
  });

  it("leaves a delivery notification to the parser", async () => {
    const outcome = await ses().events.control!(notification({ eventType: "Delivery", mail: mail() }));

    expect(outcome.handled).toBe(false);
    expect(snsSend).not.toHaveBeenCalled();
  });
});

describe("ses certificate cache", () => {
  it("stops growing, so a flood of cert URLs can't fill memory", async () => {
    const request = notification({ eventType: "Delivery", mail: mail() });
    const body = JSON.parse(request.rawBody) as Record<string, string>;

    for (let index = 0; index < MAX_CACHED_CERTIFICATES + 5; index += 1) {
      body.SigningCertURL = `https://sns.${REGION}.amazonaws.com/cert-${index}.pem`;
      await ses().events.verify({ ...request, rawBody: JSON.stringify(body) });
    }

    expect(cachedCertificateCount()).toBe(MAX_CACHED_CERTIFICATES);
  });
});
