import { createSign, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messageEvents, messages, providers, suppressions } from "@/lib/db/schema";
import { MAX_WEBHOOK_BODY_BYTES } from "@/lib/webhooks/receive";
import { acceptMessage } from "@/lib/messages/create";
import { SNS_CERTIFICATE, SNS_PRIVATE_KEY } from "../fixtures/sns-certificate";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

// SNS's real ConfirmSubscriptionCommand needs credentials this test doesn't have. Every other
// AWS call this route can trigger is exercised at the provider level in tests/unit/ses.test.ts.
const { confirmSubscription } = vi.hoisted(() => ({ confirmSubscription: vi.fn(async () => ({ SubscriptionArn: "sub" })) }));
vi.mock("@aws-sdk/client-sns", () => ({
  SNSClient: class {
    send(command: { constructor: { name: string } }) {
      if (command.constructor.name === "ConfirmSubscriptionCommand") return confirmSubscription();
      throw new Error(`unexpected SNS command in this test: ${command.constructor.name}`);
    }
  },
  ConfirmSubscriptionCommand: class ConfirmSubscriptionCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  },
  CreateTopicCommand: class CreateTopicCommand {},
  SetTopicAttributesCommand: class SetTopicAttributesCommand {},
  SubscribeCommand: class SubscribeCommand {},
}));

const { POST } = await import("@/app/api/webhooks/[adapter]/[providerId]/route");

const SES_CREDENTIALS = { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", region: "us-west-2" };
const TOPIC_ARN = "arn:aws:sns:us-west-2:123456789012:mail-events-example-com";
const SES_REGION = "us-west-2";
const SNS_CERT_URL = `https://sns.${SES_REGION}.amazonaws.com/SimpleNotificationService-1234.pem`;

/** Signs an SNS envelope the way SNS does, over the canonical field list for its type. */
function snsSigned(message: Record<string, string>, signatureVersion = "2"): Record<string, string> {
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
    SigningCertURL: SNS_CERT_URL,
    Signature: createSign(algorithm).update(canonical, "utf8").sign(SNS_PRIVATE_KEY.trim(), "base64"),
  };
}

function snsNotification(event: Record<string, unknown>, signatureVersion = "2"): string {
  return JSON.stringify(
    snsSigned(
      {
        Type: "Notification",
        MessageId: "sns-message-1",
        TopicArn: TOPIC_ARN,
        Message: JSON.stringify(event),
        Timestamp: "2026-09-08T10:00:00.000Z",
      },
      signatureVersion,
    ),
  );
}

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

interface ErrorBody {
  error: { code: string; message: string };
}

function post(adapter: string, providerId: string, body: string, headers: Record<string, string> = {}): [Request, { params: Promise<{ adapter: string; providerId: string }> }] {
  const request = new Request(`http://localhost/api/webhooks/${adapter}/${providerId}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  return [request, { params: Promise.resolve({ adapter, providerId }) }];
}

function mailpaceBody(status: string, providerMessageId = "4210"): string {
  return JSON.stringify({
    event: `email.${status}`,
    payload: {
      status,
      id: providerMessageId,
      to: "person@example.net",
      updated_at: "2026-09-08T10:00:04.000Z",
      error: status === "bounced" ? "550 5.1.1 user unknown" : null,
    },
  });
}

function signature(body: string, privateKey = keys.privateKey): Record<string, string> {
  return { "x-mailpace-signature": sign(null, Buffer.from(body), privateKey).toString("base64") };
}

async function sentMessage(fixture: Fixture, providerMessageId = "4210"): Promise<string> {
  const { message } = await acceptMessage(
    fixture.key,
    { from: "Ada <ada@example.com>", to: ["person@example.net"], subject: "Hello", html: "<p>Hi</p>" },
    null,
  );
  await db
    .update(messages)
    .set({ status: "sent", providerId: fixture.providerId, providerMessageId })
    .where(eq(messages.id, message.id));
  return message.id;
}

async function statusOf(id: string): Promise<string> {
  const [row] = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
  if (!row) throw new Error("message disappeared");
  return row.status;
}

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture({ providerAdapter: "mailpace", settings: { webhookPublicKey: publicKey } });
});

describe("POST /api/webhooks/:adapter/:providerId", () => {
  it("applies a signed event to the message it names", async () => {
    const id = await sentMessage(fixture);
    const body = mailpaceBody("delivered");

    const response = await POST(...post("mailpace", fixture.providerId, body, signature(body)));

    expect(response.status).toBe(200);
    expect(await statusOf(id)).toBe("delivered");
  });

  it("rejects a forged signature with 401 and changes nothing", async () => {
    const id = await sentMessage(fixture);
    const body = mailpaceBody("delivered");
    const attacker = generateKeyPairSync("ed25519");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const response = await POST(...post("mailpace", fixture.providerId, body, signature(body, attacker.privateKey)));
      const error = (await response.json()) as ErrorBody;

      expect(response.status).toBe(401);
      expect(error.error.code).toBe("invalid_signature");
      expect(await statusOf(id)).toBe("sent");

      const messages = warn.mock.calls.flatMap((call) => call.slice(1).map((part) => String(part ?? "")));
      expect(messages.some((line) => line.includes(fixture.providerId))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects an unsigned request with 401", async () => {
    const body = mailpaceBody("delivered");

    const response = await POST(...post("mailpace", fixture.providerId, body));

    expect(response.status).toBe(401);
  });

  it("applies a retried webhook once", async () => {
    const id = await sentMessage(fixture);
    const body = mailpaceBody("delivered");

    await POST(...post("mailpace", fixture.providerId, body, signature(body)));
    const second = await POST(...post("mailpace", fixture.providerId, body, signature(body)));

    expect(second.status).toBe(200);
    const rows = await db.select().from(messageEvents).where(eq(messageEvents.messageId, id));
    expect(rows.filter((row) => row.status === "delivered")).toHaveLength(1);
  });

  it("takes an event for a provider id it doesn't know without failing the provider's retry", async () => {
    const body = mailpaceBody("delivered", "not-ours");

    const response = await POST(...post("mailpace", fixture.providerId, body, signature(body)));
    const applied = (await response.json()) as { applied: number; ignored: number };

    expect(response.status).toBe(200);
    expect(applied.applied).toBe(0);
    expect(applied.ignored).toBe(1);
  });

  it("suppresses the recipient when a hard bounce arrives", async () => {
    await sentMessage(fixture);
    const body = mailpaceBody("bounced");

    await POST(...post("mailpace", fixture.providerId, body, signature(body)));

    const rows = await db.query.suppressions.findMany();
    expect(rows.map((row) => row.address)).toEqual(["person@example.net"]);
  });

  it("returns 401 invalid_signature for a provider id it doesn't have, so probing can't enumerate ids", async () => {
    const body = mailpaceBody("delivered");

    const response = await POST(...post("mailpace", "pac_nothere", body, signature(body)));
    const error = (await response.json()) as ErrorBody;

    expect(response.status).toBe(401);
    expect(error.error.code).toBe("invalid_signature");
    expect(error.error.message).not.toContain("pac_nothere");
  });

  it("returns 401 invalid_signature when the path names a different adapter than the provider's", async () => {
    const body = mailpaceBody("delivered");

    const response = await POST(...post("ses", fixture.providerId, body, signature(body)));
    const error = (await response.json()) as ErrorBody;

    expect(response.status).toBe(401);
    expect(error.error.code).toBe("invalid_signature");
  });

  it("verifies the raw body, not a re-serialized one", async () => {
    const id = await sentMessage(fixture);
    // Same JSON, different key order: a receiver that re-serialized would break the signature.
    const body = `{"payload":{"status":"delivered","id":"4210","to":"person@example.net","updated_at":"2026-09-08T10:00:04.000Z"},"event":"email.delivered"}`;

    const response = await POST(...post("mailpace", fixture.providerId, body, signature(body)));

    expect(response.status).toBe(200);
    expect(await statusOf(id)).toBe("delivered");
  });

  it("accepts a signed body that isn't JSON and applies zero events, so the provider stops retrying it", async () => {
    const body = "not json";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const response = await POST(...post("mailpace", fixture.providerId, body, signature(body)));
      const counts = (await response.json()) as { applied: number; ignored: number };

      expect(response.status).toBeLessThan(300);
      expect(counts).toEqual({ applied: 0, ignored: 0 });

      const messages = warn.mock.calls.flatMap((call) => call.slice(1).map((part) => String(part ?? "")));
      expect(messages.some((line) => line.includes(fixture.providerId))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("mock providers", () => {
  it("refuses an unsigned event, so nothing outside the worker can apply one", async () => {
    const mock = await seedFixture();
    const { message } = await acceptMessage(
      mock.key,
      { from: "Ada <ada@example.com>", to: ["person@example.net"], subject: "Hello", html: "<p>Hi</p>" },
      null,
    );
    await db
      .update(messages)
      .set({ status: "sent", providerId: mock.providerId, providerMessageId: "m-1" })
      .where(eq(messages.id, message.id));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const body = JSON.stringify({ id: "m-1", status: "bounced", recipients: ["someone@example.org"] });
      const response = await POST(...post("mock", mock.providerId, body));

      expect(response.status).toBe(401);
      expect(await statusOf(message.id)).toBe("sent");
      expect(await db.select().from(suppressions)).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses a control message", async () => {
    const mock = await seedFixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const response = await POST(...post("mock", mock.providerId, JSON.stringify({ control: "confirm" })));

      expect(response.status).toBe(401);
      const [provider] = await db.select().from(providers).where(eq(providers.id, mock.providerId)).limit(1);
      expect(provider?.settings.subscriptionConfirmed).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("SNS callbacks on an SES account", () => {
  async function sesProvider(): Promise<Fixture> {
    return seedFixture({ providerAdapter: "ses", credentials: SES_CREDENTIALS, settings: { topicArn: TOPIC_ARN } });
  }

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).startsWith(`https://sns.${SES_REGION}.amazonaws.com/`)) return new Response(SNS_CERTIFICATE.trim());
        throw new Error(`unexpected fetch of ${String(url)}`);
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an SNS notification that isn't signed with the provider's key", async () => {
    const ses = await sesProvider();
    const body = JSON.stringify({
      Type: "Notification",
      MessageId: "sns-1",
      TopicArn: TOPIC_ARN,
      Message: JSON.stringify({ eventType: "Delivery", mail: { messageId: "aws-1", destination: [] } }),
      Timestamp: "2026-09-08T10:00:00.000Z",
      SignatureVersion: "1",
      SigningCertURL: "https://attacker.example.com/cert.pem",
      Signature: Buffer.from("forged").toString("base64"),
    });

    const response = await POST(...post("ses", ses.providerId, body));
    const error = (await response.json()) as ErrorBody;

    expect(response.status).toBe(401);
    expect(error.error.code).toBe("invalid_signature");
  });

  it("rejects an unsigned SNS envelope", async () => {
    const ses = await sesProvider();
    const body = JSON.stringify({ Type: "Notification", MessageId: "sns-1", TopicArn: TOPIC_ARN, Message: "{}" });

    const response = await POST(...post("ses", ses.providerId, body));

    expect(response.status).toBe(401);
  });

  it("rejects a genuinely SNS-signed notification that uses SignatureVersion 1", async () => {
    const ses = await sesProvider();
    const body = snsNotification({ eventType: "Delivery", mail: { messageId: "aws-1", destination: [] } }, "1");

    const response = await POST(...post("ses", ses.providerId, body));
    const error = (await response.json()) as ErrorBody;

    expect(response.status).toBe(401);
    expect(error.error.code).toBe("invalid_signature");
  });

  it("accepts a genuinely SNS-signed SignatureVersion 2 notification and applies the event", async () => {
    const ses = await sesProvider();
    const { message } = await acceptMessage(
      ses.key,
      { from: "Ada <ada@example.com>", to: ["person@example.net"], subject: "Hello", html: "<p>Hi</p>" },
      null,
    );
    await db
      .update(messages)
      .set({ status: "sent", providerId: ses.providerId, providerMessageId: "aws-1" })
      .where(eq(messages.id, message.id));

    const body = snsNotification(
      { eventType: "Delivery", mail: { messageId: "aws-1", destination: ["person@example.net"] } },
      "2",
    );

    const response = await POST(...post("ses", ses.providerId, body));

    expect(response.status).toBe(200);
    expect(await statusOf(message.id)).toBe("delivered");
  });

  it("confirms a genuinely SNS-signed subscription confirmation", async () => {
    const ses = await sesProvider();
    const body = JSON.stringify(
      snsSigned({
        Type: "SubscriptionConfirmation",
        MessageId: "sns-confirm-1",
        TopicArn: TOPIC_ARN,
        Token: "confirm-token",
        Message: "You have chosen to subscribe to this topic.",
        SubscribeURL: `https://sns.${SES_REGION}.amazonaws.com/?Action=ConfirmSubscription`,
        Timestamp: "2026-09-08T10:00:00.000Z",
      }),
    );

    const response = await POST(...post("ses", ses.providerId, body));
    const { status } = (await response.json()) as { status: string };

    expect(response.status).toBe(200);
    expect(status).toBe("subscription_confirmed");
    const [provider] = await db
      .select()
      .from(providers)
      .where(eq(providers.id, ses.providerId))
      .limit(1);
    expect(provider?.settings.subscriptionConfirmed).toBe("true");
  });

  it("acknowledges an unsubscribe confirmation without erroring or recording an event", async () => {
    const ses = await sesProvider();
    const body = JSON.stringify(
      snsSigned({
        Type: "UnsubscribeConfirmation",
        MessageId: "sns-unsub-1",
        TopicArn: TOPIC_ARN,
        Token: "unsub-token",
        Message: "You have chosen to deactivate your subscription to this topic.",
        SubscribeURL: `https://sns.${SES_REGION}.amazonaws.com/?Action=ConfirmSubscription`,
        Timestamp: "2026-09-08T10:00:00.000Z",
      }),
    );

    const response = await POST(...post("ses", ses.providerId, body));
    const counts = (await response.json()) as { applied: number; ignored: number };

    expect(response.status).toBe(200);
    expect(counts).toEqual({ applied: 0, ignored: 0 });
  });

  it("rejects a body over the 256 KB webhook cap before it's fully buffered", async () => {
    const ses = await sesProvider();
    const oversized = JSON.stringify({ Type: "Notification", Message: "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1) });

    const response = await POST(...post("ses", ses.providerId, oversized));
    const error = (await response.json()) as ErrorBody;

    expect(response.status).toBe(422);
    expect(error.error.code).toBe("attachment_too_large");
  });
});
