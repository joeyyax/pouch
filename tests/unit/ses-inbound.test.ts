import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Adapter, SignedRequest } from "@/lib/providers/adapters/types";

const receiptSend = vi.fn();
const s3Send = vi.fn();

class FakeCommand {
  constructor(public readonly input: Record<string, unknown>) {}
}
function commands(names: string[]): Record<string, unknown> {
  return Object.fromEntries(names.map((name) => [name, { [name]: class extends FakeCommand {} }[name]]));
}

vi.mock("@aws-sdk/client-ses", () => ({
  SESClient: class {
    send(command: FakeCommand) {
      return receiptSend(command);
    }
  },
  ...commands([
    "CreateReceiptRuleCommand",
    "DeleteReceiptRuleCommand",
    "DescribeActiveReceiptRuleSetCommand",
    "SetReceiptRulePositionCommand",
    "UpdateReceiptRuleCommand",
  ]),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send(command: FakeCommand) {
      return s3Send(command);
    }
  },
  ...commands(["GetObjectCommand", "DeleteObjectCommand", "PutObjectCommand"]),
}));

const { buildAdapter } = await import("@/lib/providers/adapters");
const { InboundUnavailableError } = await import("@/lib/providers/adapters/types");

const TOPIC_ARN = "arn:aws:sns:us-west-2:123456789012:mail-events-pac_tenant";
const BUCKET = "pouch-inbound";
const ROUTE = { domainId: "dom_abc", host: "intake.example.com" };

function ses(credentials: Record<string, string> = { inboundBucket: BUCKET }, settings: Record<string, string> = { topicArn: TOPIC_ARN }): Adapter {
  return buildAdapter("ses", { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", region: "us-west-2", ...credentials }, settings, "pac_tenant");
}

function named(command: FakeCommand): string {
  return command.constructor.name;
}

function awsError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

/** The body SNS posts; its signature is `events.verify`'s job, which runs before `received`. */
function announcement(payload: Record<string, unknown>, topicArn = TOPIC_ARN): SignedRequest {
  return {
    rawBody: JSON.stringify({ Type: "Notification", MessageId: "sns-1", TopicArn: topicArn, Message: JSON.stringify(payload) }),
    headers: {},
  };
}

function received(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    notificationType: "Received",
    mail: { messageId: "ses-inbound-1" },
    receipt: {
      recipients: ["abc123@intake.example.com"],
      spamVerdict: { status: "PASS" },
      virusVerdict: { status: "FAIL" },
      spfVerdict: { status: "GRAY" },
      dkimVerdict: { status: "PASS" },
      dmarcVerdict: { status: "PROCESSING_FAILED" },
      action: { type: "S3", bucketName: BUCKET, objectKey: "inbound/dom_abc/ses-inbound-1" },
    },
    ...overrides,
  };
}

beforeEach(() => {
  receiptSend.mockReset();
  s3Send.mockReset();
});

describe("ses inbound records", () => {
  it("proposes an MX on the host to the region's SES inbound endpoint", () => {
    expect(ses().inbound!.records("intake.example.com")).toEqual([
      { type: "MX", name: "intake.example.com", value: "inbound-smtp.us-west-2.amazonaws.com", priority: 10, required: false },
    ]);
  });
});

describe("ses inbound routing", () => {
  it("adds a rule to the active rule set sending the host's mail to the bucket and the row's topic", async () => {
    receiptSend.mockImplementation(async (command: FakeCommand) =>
      named(command) === "DescribeActiveReceiptRuleSetCommand" ? { Metadata: { Name: "existing-set" }, Rules: [{ Name: "someone-else" }] } : {},
    );

    const settings = await ses().inbound!.open!(ROUTE);

    const create = receiptSend.mock.calls.map(([command]) => command as FakeCommand).find((command) => named(command) === "CreateReceiptRuleCommand");
    expect(create?.input).toEqual({
      RuleSetName: "existing-set",
      Rule: {
        Name: "mail-inbound-dom-abc",
        Enabled: true,
        Recipients: ["intake.example.com"],
        ScanEnabled: true,
        TlsPolicy: "Optional",
        Actions: [
          { S3Action: { BucketName: BUCKET, ObjectKeyPrefix: "inbound/dom_abc/", TopicArn: TOPIC_ARN } },
          { StopAction: { Scope: "RuleSet" } },
        ],
      },
    });
    // No `After`: SES puts it first, ahead of the account's own rules.
    expect(create?.input).not.toHaveProperty("After");
    expect(settings).toEqual({ ruleSet: "existing-set", rule: "mail-inbound-dom-abc" });
  });

  it("updates the domain's rule in place, leaving it where it is behind only Pouch's own rules", async () => {
    receiptSend.mockImplementation(async (command: FakeCommand) =>
      named(command) === "DescribeActiveReceiptRuleSetCommand"
        ? { Metadata: { Name: "existing-set" }, Rules: [{ Name: "mail-inbound-dom-other" }, { Name: "mail-inbound-dom-abc" }, { Name: "catch-all" }] }
        : {},
    );

    await ses().inbound!.open!(ROUTE);

    expect(receiptSend.mock.calls.map(([command]) => named(command))).toEqual(["DescribeActiveReceiptRuleSetCommand", "UpdateReceiptRuleCommand"]);
  });

  it("moves the domain's rule first when one of the account's own rules runs ahead of it", async () => {
    receiptSend.mockImplementation(async (command: FakeCommand) =>
      named(command) === "DescribeActiveReceiptRuleSetCommand"
        ? { Metadata: { Name: "existing-set" }, Rules: [{ Name: "catch-all" }, { Name: "mail-inbound-dom-abc" }] }
        : {},
    );

    await ses().inbound!.open!(ROUTE);

    const moved = receiptSend.mock.calls.map(([command]) => command as FakeCommand).find((command) => named(command) === "SetReceiptRulePositionCommand");
    expect(moved?.input).toEqual({ RuleSetName: "existing-set", RuleName: "mail-inbound-dom-abc" });
  });

  it("refuses when the account has no active rule set, and never creates or activates one", async () => {
    receiptSend.mockResolvedValue({});

    await expect(ses().inbound!.open!(ROUTE)).rejects.toBeInstanceOf(InboundUnavailableError);
    expect(receiptSend.mock.calls.map(([command]) => named(command))).toEqual(["DescribeActiveReceiptRuleSetCommand"]);
  });

  it("refuses without an inbound bucket, before calling SES", async () => {
    await expect(ses({}).inbound!.open!(ROUTE)).rejects.toBeInstanceOf(InboundUnavailableError);
    expect(receiptSend).not.toHaveBeenCalled();
  });

  it("refuses before the row has a topic to announce mail on", async () => {
    await expect(ses(undefined, {}).inbound!.open!(ROUTE)).rejects.toBeInstanceOf(InboundUnavailableError);
    expect(receiptSend).not.toHaveBeenCalled();
  });

  it("reads SES refusing the bucket or topic as not set up, not as an outage", async () => {
    receiptSend.mockImplementation(async (command: FakeCommand) => {
      if (named(command) === "DescribeActiveReceiptRuleSetCommand") return { Metadata: { Name: "existing-set" }, Rules: [] };
      throw awsError("InvalidS3ConfigurationException");
    });

    await expect(ses().inbound!.open!(ROUTE)).rejects.toBeInstanceOf(InboundUnavailableError);
  });

  it("deletes the stored rule, and treats one already gone as closed", async () => {
    receiptSend.mockRejectedValueOnce(awsError("RuleDoesNotExistException"));

    await ses().inbound!.close!(ROUTE, { ruleSet: "existing-set", rule: "mail-inbound-dom-abc" });

    const [command] = receiptSend.mock.calls[0] as [FakeCommand];
    expect(named(command)).toBe("DeleteReceiptRuleCommand");
    expect(command.input).toEqual({ RuleSetName: "existing-set", RuleName: "mail-inbound-dom-abc" });
  });

  it("calls nothing to close a domain it never opened", async () => {
    await ses().inbound!.close!(ROUTE, {});
    expect(receiptSend).not.toHaveBeenCalled();
  });
});

describe("ses received mail", () => {
  it("names the domain and message from the key, carries the verdicts, and reads nothing until asked", async () => {
    const mail = await ses().inbound!.received!(announcement(received()));

    expect(mail).toMatchObject({
      domainId: "dom_abc",
      providerMessageId: "ses-inbound-1",
      recipients: ["abc123@intake.example.com"],
      verdicts: { spam: "pass", virus: "fail", spf: "gray", dkim: "pass", dmarc: "processing_failed" },
    });
    expect(s3Send).not.toHaveBeenCalled();

    s3Send.mockResolvedValue({ Body: { transformToByteArray: async () => new Uint8Array(Buffer.from("From: a@example.net\r\n\r\nhi")) } });
    expect((await mail!.read())?.toString()).toBe("From: a@example.net\r\n\r\nhi");
    expect((s3Send.mock.calls[0]![0] as FakeCommand).input).toEqual({ Bucket: BUCKET, Key: "inbound/dom_abc/ses-inbound-1" });

    await mail!.discard();
    const [deleted] = s3Send.mock.calls[1] as [FakeCommand];
    expect(named(deleted)).toBe("DeleteObjectCommand");
    expect(deleted.input).toEqual({ Bucket: BUCKET, Key: "inbound/dom_abc/ses-inbound-1" });
  });

  it("reads a copy that's already gone as null, and any other failure as a throw", async () => {
    const mail = await ses().inbound!.received!(announcement(received()));

    s3Send.mockRejectedValueOnce(awsError("NoSuchKey"));
    expect(await mail!.read()).toBeNull();

    s3Send.mockRejectedValueOnce(awsError("AccessDenied"));
    await expect(mail!.read()).rejects.toThrow();
  });

  it("isn't an announcement for a delivery event, another topic, another bucket or a key outside the prefix", async () => {
    const inbound = ses().inbound!;
    const s3 = (bucketName: string, objectKey: string) => ({ ...received(), receipt: { action: { type: "S3", bucketName, objectKey } } });

    expect(await inbound.received!(announcement({ eventType: "Delivery", mail: { messageId: "m" } }))).toBeNull();
    expect(await inbound.received!(announcement(received(), `${TOPIC_ARN}-other`))).toBeNull();
    expect(await inbound.received!(announcement(s3("someone-elses-bucket", "inbound/dom_abc/x")))).toBeNull();
    expect(await inbound.received!(announcement(s3(BUCKET, "elsewhere/dom_abc/x")))).toBeNull();
    expect(s3Send).not.toHaveBeenCalled();
  });

  it("finds a stored message by its key for a replay, and nothing outside the routing", () => {
    const inbound = ses().inbound!;

    expect(inbound.stored!("inbound/dom_abc/ses-inbound-1")).toMatchObject({ domainId: "dom_abc", providerMessageId: "ses-inbound-1", recipients: [], verdicts: null });
    expect(inbound.stored!("inbound/dom_abc")).toBeNull();
    expect(inbound.stored!("other/dom_abc/x")).toBeNull();
    expect(ses({}).inbound!.stored!("inbound/dom_abc/x")).toBeNull();
  });
});
