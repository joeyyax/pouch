import { createSign } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SNS_CERTIFICATE, SNS_PRIVATE_KEY } from "../fixtures/sns-certificate";
import { db } from "@/lib/db";
import { addressForwardTargets, addressForwards, addresses, domains, inboundMessages, providers, webhookDeliveries } from "@/lib/db/schema";
import { moveInboundRoute } from "@/lib/inbound/manage";
import { main as replay } from "@/scripts/replay-inbound";
import { getObject } from "@/lib/storage";
import { receive } from "@/lib/webhooks/receive";
import { deleteDomain } from "@/lib/domains";
import { apiKeyActor } from "@/lib/activity/record";
import { GET as readDomainInbound, PATCH as patchDomainInbound } from "@/app/api/v1/domains/[id]/inbound/route";
import { GET as readInbound } from "@/app/api/v1/inbound/[id]/route";
import { GET as download } from "@/app/download/[token]/route";
import { inboundBodyKey, readInboundBody, readInboundObject } from "@/lib/inbound/attachments";
import { POST as createAddressRoute } from "@/app/api/v1/addresses/route";
import { createEndpoint } from "@/lib/webhooks/endpoints";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { addProvider, resetDatabase, seedFixture, type Fixture } from "./fixtures";

const { SES_BUCKET, sesBucket, receipt, rules, identity } = vi.hoisted(() => ({
  SES_BUCKET: "pouch-inbound-test",
  /** The provider's own bucket, which SES writes to. Private storage stays the real MinIO. */
  sesBucket: new Map<string, Buffer>(),
  receipt: [] as { name: string; input: Record<string, unknown> }[],
  /** The rule names the fake SES account holds in its active set. */
  rules: new Set<string>(),
  /** How the fake SES answers an identity removal. */
  identity: { removal: "missing" as "missing" | "fail" },
}));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  class S3Client extends actual.S3Client {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    override send(command: any, ...rest: any[]): any {
      const input = command.input as { Bucket?: string; Key?: string };
      if (input.Bucket !== SES_BUCKET) return (super.send as (...args: unknown[]) => unknown)(command, ...rest);
      if (command instanceof actual.GetObjectCommand) {
        const body = sesBucket.get(input.Key!);
        if (!body) return Promise.reject(Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" }));
        return Promise.resolve({ Body: { transformToByteArray: async () => new Uint8Array(body) } });
      }
      if (command instanceof actual.DeleteObjectCommand) {
        sesBucket.delete(input.Key!);
        return Promise.resolve({});
      }
      return Promise.reject(new Error(`unexpected ${command.constructor.name} on the SES bucket`));
    }
  }
  return { ...actual, S3Client };
});

vi.mock("@aws-sdk/client-ses", () => {
  class Command {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  const named = (name: string) => ({ [name]: class extends Command {} })[name]!;
  return {
    SESClient: class {
      send(command: Command) {
        const name = command.constructor.name;
        receipt.push({ name, input: command.input });
        const rule = command.input.Rule as { Name: string } | undefined;
        if (name === "DescribeActiveReceiptRuleSetCommand") {
          return Promise.resolve({ Metadata: { Name: "account-set" }, Rules: [...rules].map((Name) => ({ Name })) });
        }
        if (name === "CreateReceiptRuleCommand") rules.add(rule!.Name);
        if (name === "DeleteReceiptRuleCommand") rules.delete(command.input.RuleName as string);
        return Promise.resolve({});
      }
    },
    CreateReceiptRuleCommand: named("CreateReceiptRuleCommand"),
    DeleteReceiptRuleCommand: named("DeleteReceiptRuleCommand"),
    DescribeActiveReceiptRuleSetCommand: named("DescribeActiveReceiptRuleSetCommand"),
    SetReceiptRulePositionCommand: named("SetReceiptRulePositionCommand"),
    UpdateReceiptRuleCommand: named("UpdateReceiptRuleCommand"),
  };
});

// Deleting a domain removes its SES identity; this account has none.
vi.mock("@aws-sdk/client-sesv2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-sesv2")>();
  return {
    ...actual,
    SESv2Client: class {
      send() {
        const name = identity.removal === "missing" ? "NotFoundException" : "InternalFailure";
        return Promise.reject(Object.assign(new Error(name), { name, $metadata: { httpStatusCode: identity.removal === "missing" ? 404 : 400 } }));
      }
    },
  };
});

vi.mock("@/lib/webhooks/ssrf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/webhooks/ssrf")>();
  return { ...actual, resolvePublicTarget: async (url: string) => ({ url, address: "203.0.113.10", family: 4 }) };
});

const TOPIC_ARN = "arn:aws:sns:us-west-2:123456789012:mail-events-tenant";
const CERT_URL = "https://sns.us-west-2.amazonaws.com/SimpleNotificationService-1.pem";
const PDF = Buffer.from("%PDF-1.4 not really a pdf\n");

const RAW = Buffer.from(
  [
    "From: Ada Lovelace <ada@example.net>",
    "To: Intake <abc123@intake.example.com>",
    "Subject: Invoice for September",
    "Message-ID: <inv-1@example.net>",
    "X-SES-Spam-Verdict: PASS",
    "X-SES-Virus-Verdict: PASS",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "See attached.",
    "--b1",
    'Content-Type: application/pdf; name="invoice.pdf"',
    'Content-Disposition: attachment; filename="invoice.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    PDF.toString("base64"),
    "--b1--",
    "",
  ].join("\r\n"),
);

let fixture: Fixture;
const realFetch = globalThis.fetch;

function fetchDownload(url: string): Promise<Response> {
  const token = new URL(url).pathname.split("/").pop()!;
  return download(new Request(url), { params: Promise.resolve({ token }) });
}

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

function authorized(url: string, init: RequestInit = {}): Request {
  return new Request(url, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${fixture.secret}` } });
}

async function setInbound(body: Record<string, unknown>) {
  const response = await patchDomainInbound(
    authorized(`http://localhost/v1/domains/${fixture.domainId}/inbound`, { method: "PATCH", body: JSON.stringify(body) }),
    context(fixture.domainId),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Puts a message in the SES bucket the way the receipt rule's S3 action does. */
function stored(domainId: string, messageId = "ses-1"): string {
  const objectKey = `inbound/${domainId}/${messageId}`;
  sesBucket.set(objectKey, RAW);
  return objectKey;
}

/** What SES publishes once its S3 action has stored a message, signed as SNS signs it. */
function announcement(
  domainId: string,
  messageId = "ses-1",
  recipients = ["abc123@intake.example.com", "bcc-token@intake.example.com"],
  virus = "PASS",
): Request {
  const objectKey = `inbound/${domainId}/${messageId}`;
  const message = {
    Type: "Notification",
    MessageId: crypto.randomUUID(),
    TopicArn: TOPIC_ARN,
    Timestamp: "2026-09-28T10:00:00.000Z",
    Message: JSON.stringify({
      notificationType: "Received",
      mail: { messageId },
      receipt: {
        recipients,
        spamVerdict: { status: "PASS" },
        virusVerdict: { status: virus },
        spfVerdict: { status: "PASS" },
        dkimVerdict: { status: "PASS" },
        dmarcVerdict: { status: "FAIL" },
        action: { type: "S3", topicArn: TOPIC_ARN, bucketName: SES_BUCKET, objectKey },
      },
    }),
  };
  const canonical = ["Message", "MessageId", "Timestamp", "TopicArn", "Type"]
    .map((field) => `${field}\n${message[field as keyof typeof message]}\n`)
    .join("");
  const body = {
    ...message,
    SignatureVersion: "2",
    SigningCertURL: CERT_URL,
    Signature: createSign("RSA-SHA256").update(canonical, "utf8").sign(SNS_PRIVATE_KEY.trim(), "base64"),
  };
  return new Request(`http://localhost/api/webhooks/ses/${fixture.providerId}`, { method: "POST", body: JSON.stringify(body) });
}

async function post(request: Request) {
  const response = await receive("ses", fixture.providerId, request);
  return (await response.json()) as Record<string, number>;
}

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  sesBucket.clear();
  receipt.length = 0;
  rules.clear();
  identity.removal = "missing";
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === CERT_URL ? Promise.resolve(new Response(SNS_CERTIFICATE.trim())) : realFetch(input, init),
  );
  fixture = await seedFixture({
    providerAdapter: "ses",
    credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", region: "us-west-2", inboundBucket: SES_BUCKET },
    settings: { topicArn: TOPIC_ARN, configurationSetName: "mail-events-tenant", subscriptionConfirmed: "true" },
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe("SES inbound", () => {
  it("routes the chosen subdomain to Pouch and lists its MX with the domain's records", async () => {
    const { status, body } = await setInbound({ enabled: true, webhook_url: "https://hooks.example.com/inbound", subdomain: "intake" });

    expect(status).toBe(200);
    expect(body).toMatchObject({ enabled: true, subdomain: "intake", host: "intake.example.com", receiver_url: null });
    expect(body.dns_records).toContainEqual({
      type: "MX",
      name: "intake.example.com",
      value: "inbound-smtp.us-west-2.amazonaws.com",
      priority: 10,
      required: false,
    });

    const created = receipt.find((call) => call.name === "CreateReceiptRuleCommand");
    expect(created?.input).toMatchObject({
      RuleSetName: "account-set",
      Rule: {
        Recipients: ["intake.example.com"],
        Actions: [
          { S3Action: { BucketName: SES_BUCKET, ObjectKeyPrefix: `inbound/${fixture.domainId}/`, TopicArn: TOPIC_ARN } },
          { StopAction: { Scope: "RuleSet" } },
        ],
      },
    });
    const [domain] = await db.select().from(domains).where(eq(domains.id, fixture.domainId));
    expect(domain?.inboundProviderSettings).toEqual({ ruleSet: "account-set", rule: expect.stringMatching(/^mail-inbound-/) });
  });

  it("moves the rule and swaps the records when the subdomain changes", async () => {
    await setInbound({ enabled: true, webhook_url: "https://hooks.example.com/inbound", subdomain: "intake" });
    const { body } = await setInbound({ enabled: true, subdomain: "receive" });

    const names = (body.dns_records as { name: string }[]).map((record) => record.name);
    expect(names).toContain("receive.example.com");
    expect(names).not.toContain("intake.example.com");
    const updated = receipt.find((call) => call.name === "UpdateReceiptRuleCommand");
    expect(updated?.input).toMatchObject({ Rule: { Recipients: ["receive.example.com"] } });

    const read = await readDomainInbound(authorized(`http://localhost/v1/domains/${fixture.domainId}/inbound`), context(fixture.domainId));
    expect(await read.json()).toMatchObject({ subdomain: "receive", host: "receive.example.com" });
  });

  it("refuses a subdomain that holds the domain's MAIL FROM records, and changes nothing", async () => {
    const mailFrom = [
      { type: "MX" as const, name: "mail.example.com", value: "feedback-smtp.us-west-2.amazonses.com", priority: 10, required: false },
      { type: "TXT" as const, name: "mail.example.com", value: "v=spf1 include:amazonses.com ~all", required: false },
    ];
    await db.update(domains).set({ dnsRecords: mailFrom }).where(eq(domains.id, fixture.domainId));

    const { status, body } = await setInbound({ enabled: true, webhook_url: "https://hooks.example.com/inbound", subdomain: "mail" });

    expect(status).toBe(422);
    expect(body.error).toMatchObject({ code: "validation_failed", field: "subdomain" });
    const [domain] = await db.select().from(domains).where(eq(domains.id, fixture.domainId));
    expect(domain?.inboundEnabled).toBe(false);
    expect(domain?.dnsRecords).toEqual(mailFrom);
    expect(receipt.some((call) => call.name === "CreateReceiptRuleCommand")).toBe(false);
  });

  it("refuses to enable on a provider with no inbound bucket, and changes nothing", async () => {
    fixture = await seedFixture({
      providerAdapter: "ses",
      credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", region: "us-west-2" },
      settings: { topicArn: TOPIC_ARN, configurationSetName: "mail-events-tenant", subscriptionConfirmed: "true" },
    });

    const { status, body } = await setInbound({ enabled: true, webhook_url: "https://hooks.example.com/inbound" });

    expect(status).toBe(422);
    expect((body.error as { code: string }).code).toBe("capability_unavailable");
    const [domain] = await db.select().from(domains).where(eq(domains.id, fixture.domainId));
    expect(domain?.inboundEnabled).toBe(false);
    expect(domain?.dnsRecords).toEqual([]);
  });

  it("stores announced mail with its envelope recipients, raw message and attachment, then deletes SES's copy", async () => {
    await setInbound({ enabled: true, webhook_url: "https://hooks.example.com/inbound", subdomain: "intake" });

    stored(fixture.domainId);
    expect(await post(announcement(fixture.domainId))).toEqual({ accepted: 1, duplicates: 0 });

    const [row] = await db.select().from(inboundMessages).where(eq(inboundMessages.domainId, fixture.domainId));
    expect(row).toMatchObject({
      providerMessageId: "ses-1",
      fromAddress: "ada@example.net",
      fromName: "Ada Lovelace",
      to: ["abc123@intake.example.com", "bcc-token@intake.example.com"],
      subject: "Invoice for September",
      messageId: "<inv-1@example.net>",
    });
    expect(row?.text).toBeNull();
    expect(row?.html).toBeNull();
    expect(row?.bodyKey).not.toBeNull();
    expect((await readInboundBody(row!)).text?.trim()).toBe("See attached.");
    expect(row?.attachments).toMatchObject([{ filename: "invoice.pdf", contentType: "application/pdf", size: PDF.length }]);
    expect((await readInboundObject(row!, row!.rawStorageKey!)).equals(RAW)).toBe(true);
    expect(sesBucket.size).toBe(0);

    // At rest, none of it reads as plaintext.
    const storedBody = await getObject("private", inboundBodyKey(row!.storageKey!));
    const storedRaw = await getObject("private", row!.rawStorageKey!);
    const storedAttachment = await getObject("private", row!.attachments[0]!.storageKey!);
    expect(storedBody).not.toContain("See attached");
    expect(storedRaw).not.toContain("Invoice for September");
    expect(storedAttachment).not.toContain("PDF");

    const [delivery] = await db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.organizationId, fixture.organizationId), eq(webhookDeliveries.eventType, "inbound.received")));
    const data = (delivery?.payload as { data: { text: string | null; attachments: { download_url: string | null }[]; raw_download_url: string | null } }).data;
    expect(data.text?.trim()).toBe("See attached.");
    expect(data.attachments).toEqual([{ filename: "invoice.pdf", content_type: "application/pdf", size: PDF.length, quarantined: false, download_url: null }]);
    expect(data.raw_download_url).toBeNull();
  });

  it("serves the attachment and the raw message through links on the API read", async () => {
    await setInbound({ enabled: true, webhook_url: "https://hooks.example.com/inbound", subdomain: "intake" });
    stored(fixture.domainId);
    await post(announcement(fixture.domainId));
    const [row] = await db.select().from(inboundMessages).where(eq(inboundMessages.domainId, fixture.domainId));

    const response = await readInbound(authorized(`http://localhost/v1/inbound/${row!.id}`), context(row!.id));
    const message = (await response.json()) as { text: string | null; attachments: { download_url: string }[]; raw_download_url: string };
    expect(message.text?.trim()).toBe("See attached.");

    const attachment = await fetchDownload(message.attachments[0]!.download_url);
    expect(attachment.headers.get("content-type")).toBe("application/pdf");
    expect(attachment.headers.get("content-disposition")).toContain('filename="invoice.pdf"');
    expect(Buffer.from(await attachment.arrayBuffer()).equals(PDF)).toBe(true);

    const raw = await fetchDownload(message.raw_download_url);
    expect(Buffer.from(await raw.arrayBuffer()).equals(RAW)).toBe(true);

    const forged = message.raw_download_url.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    expect((await fetchDownload(forged)).status).toBe(404);
  });

  it("answers SNS's retry of an ingested message as a duplicate, though the first attempt deleted SES's copy", async () => {
    await setInbound({ enabled: true, webhook_url: "https://hooks.example.com/inbound", subdomain: "intake" });
    stored(fixture.domainId);

    await post(announcement(fixture.domainId));
    expect(sesBucket.size).toBe(0);
    expect(await post(announcement(fixture.domainId))).toEqual({ accepted: 0, duplicates: 1 });

    expect(await db.select().from(inboundMessages).where(eq(inboundMessages.domainId, fixture.domainId))).toHaveLength(1);
  });

  it("answers an announcement whose copy is gone, with nothing stored from it, without failing", async () => {
    await setInbound({ enabled: true, webhook_url: "https://hooks.example.com/inbound", subdomain: "intake" });

    expect(await post(announcement(fixture.domainId))).toEqual({ accepted: 0, duplicates: 0 });
    expect(await db.select().from(inboundMessages)).toEqual([]);
  });

  it("keeps the verdicts, and quarantines a message that failed the virus scan", async () => {
    await setInbound({ enabled: true, webhook_url: "https://hooks.example.com/inbound", subdomain: "intake" });
    stored(fixture.domainId);

    await post(announcement(fixture.domainId, "ses-1", undefined, "FAIL"));

    const [row] = await db.select().from(inboundMessages).where(eq(inboundMessages.domainId, fixture.domainId));
    expect(row?.verdicts).toEqual({ spam: "pass", virus: "fail", spf: "pass", dkim: "pass", dmarc: "fail" });
    expect(row?.rawStorageKey).toBeNull();
    expect(row?.text).toBeNull();
    expect(row?.html).toBeNull();
    expect(row?.attachments).toEqual([{ filename: "invoice.pdf", contentType: "application/pdf", size: PDF.length, storageKey: null }]);

    const response = await readInbound(authorized(`http://localhost/v1/inbound/${row!.id}`), context(row!.id));
    const message = (await response.json()) as Record<string, unknown>;
    expect(message.attachments).toEqual([{ filename: "invoice.pdf", content_type: "application/pdf", size: PDF.length, quarantined: true, download_url: null }]);
    expect(message.raw_download_url).toBeNull();
    expect(message.verdicts).toMatchObject({ virus: "fail", dmarc: "fail" });
  });

  it("replays a message SNS gave up on from its key, reading recipients and verdicts off the message", async () => {
    await setInbound({ enabled: true, webhook_url: "https://hooks.example.com/inbound", subdomain: "intake" });
    const key = stored(fixture.domainId, "ses-lost");
    const lines: string[] = [];

    expect(await replay([fixture.providerId, key], (line) => lines.push(line))).toBe(0);
    expect(lines).toEqual([`${key}: 1 accepted, 0 duplicate`]);

    const [row] = await db.select().from(inboundMessages).where(eq(inboundMessages.domainId, fixture.domainId));
    expect(row).toMatchObject({ providerMessageId: "ses-lost", to: ["abc123@intake.example.com"] });
    expect(row?.verdicts).toMatchObject({ spam: "pass", virus: "pass" });

    stored(fixture.domainId, "ses-lost");
    expect(await replay([fixture.providerId, key], () => {})).toBe(0);
    expect(await db.select().from(inboundMessages)).toHaveLength(1);
  });

  it("drops mail for a domain that turned inbound off, or that's bound to another provider", async () => {
    const other = await seedFixture();
    await setInbound({ enabled: true, webhook_url: "https://hooks.example.com/inbound" });
    await setInbound({ enabled: false });

    stored(fixture.domainId);
    stored(other.domainId, "ses-2");
    expect(await post(announcement(fixture.domainId))).toEqual({ accepted: 0, duplicates: 0 });
    expect(await post(announcement(other.domainId, "ses-2"))).toEqual({ accepted: 0, duplicates: 0 });

    expect(await db.select().from(inboundMessages)).toEqual([]);
    expect(sesBucket.size).toBe(0);
  });

  it("drops the inbound MX from the domain's records when inbound is turned off", async () => {
    const mxHosts = async () => {
      const [row] = await db.select({ records: domains.dnsRecords }).from(domains).where(eq(domains.id, fixture.domainId));
      return row!.records.filter((record) => record.type === "MX").map((record) => record.name);
    };
    await setInbound({ enabled: true, webhook_url: "https://hooks.example.com/inbound", subdomain: "intake" });
    expect(await mxHosts()).toEqual(["intake.example.com"]);

    await setInbound({ enabled: false });
    expect(await mxHosts()).toEqual([]);
  });

  it("deletes the rule when inbound is turned off, and when the domain is deleted", async () => {
    await setInbound({ enabled: true, webhook_url: "https://hooks.example.com/inbound" });
    await setInbound({ enabled: false });
    expect(rules.size).toBe(0);

    await setInbound({ enabled: true });
    expect(rules.size).toBe(1);
    await deleteDomain({ organizationId: fixture.organizationId, domainIds: [], actor: apiKeyActor(fixture.key.id, "test") }, fixture.domainId);
    expect(rules.size).toBe(0);
  });

  it("keeps the rule when deleting the domain fails at SES, so the domain that stays still receives", async () => {
    await setInbound({ enabled: true, webhook_url: "https://hooks.example.com/inbound" });
    identity.removal = "fail";

    await expect(
      deleteDomain({ organizationId: fixture.organizationId, domainIds: [], actor: apiKeyActor(fixture.key.id, "test") }, fixture.domainId),
    ).rejects.toThrow();

    const [domain] = await db.select().from(domains).where(eq(domains.id, fixture.domainId));
    expect(domain?.inboundEnabled).toBe(true);
    expect(rules.size).toBe(1);
  });

  it("moves the route when the domain cuts over to another provider", async () => {
    const NEW_TOPIC = "arn:aws:sns:us-west-2:123456789012:mail-events-other";
    const { providerId: targetId } = await addProvider(fixture, {
      providerAdapter: "ses",
      credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", region: "us-west-2", inboundBucket: SES_BUCKET },
      settings: { topicArn: NEW_TOPIC, configurationSetName: "mail-events-other", subscriptionConfirmed: "true" },
    });
    await setInbound({ enabled: true, webhook_url: "https://hooks.example.com/inbound", subdomain: "intake" });
    const [before] = await db.select().from(domains).where(eq(domains.id, fixture.domainId));
    const [from] = await db.select().from(providers).where(eq(providers.id, fixture.providerId));
    const [to] = await db.select().from(providers).where(eq(providers.id, targetId));
    // The cutover itself: the new provider's send records replace the live ones.
    await db.update(domains).set({ providerId: targetId, dnsRecords: [] }).where(eq(domains.id, fixture.domainId));
    receipt.length = 0;

    await moveInboundRoute(before!, from!, to!);

    expect(receipt.map((call) => call.name)).toEqual(["DeleteReceiptRuleCommand", "DescribeActiveReceiptRuleSetCommand", "CreateReceiptRuleCommand"]);
    expect(receipt[2]?.input).toMatchObject({ Rule: { Actions: [{ S3Action: { TopicArn: NEW_TOPIC } }, { StopAction: { Scope: "RuleSet" } }] } });
    const [after] = await db.select().from(domains).where(eq(domains.id, fixture.domainId));
    expect(after?.dnsRecords.map((record) => record.name)).toEqual(["intake.example.com"]);
    expect(after?.inboundProviderSettings).toMatchObject({ ruleSet: "account-set" });
  });
});

describe("SES mail to an address, replayed from the bucket", () => {
  async function createAddress(localPart: string): Promise<string> {
    const response = await createAddressRoute(
      authorized("http://localhost/v1/addresses", { method: "POST", body: JSON.stringify({ domain_id: fixture.domainId, local_part: localPart, expires_in: 3600 }) }),
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }

  function storedWith(verdictHeaders: Record<string, string>, messageId: string): string {
    const raw = RAW.toString().replace("X-SES-Spam-Verdict: PASS", `X-SES-Spam-Verdict: ${verdictHeaders.spam}`).replace("X-SES-Virus-Verdict: PASS", `X-SES-Virus-Verdict: ${verdictHeaders.virus}`);
    const objectKey = `inbound/${fixture.domainId}/${messageId}`;
    sesBucket.set(objectKey, Buffer.from(raw));
    return objectKey;
  }

  async function counts(id: string) {
    const [row] = await db.select().from(addresses).where(eq(addresses.id, id));
    return row!;
  }

  it("delivers spam flagged to the creating key's endpoint, and drops a virus without keeping it", async () => {
    await setInbound({ enabled: true, webhook_url: "https://hooks.example.com/inbound", subdomain: "intake" });
    await createEndpoint({ organizationId: fixture.organizationId, apiKeyId: fixture.key.id, url: "https://agent.example.net/hook", events: ["address.received"] });
    const id = await createAddress("abc123");

    expect(await replay([fixture.providerId, storedWith({ spam: "FAIL", virus: "PASS" }, "ses-spam")], () => {})).toBe(0);
    expect(await replay([fixture.providerId, storedWith({ spam: "PASS", virus: "FAIL" }, "ses-virus")], () => {})).toBe(0);

    expect(await counts(id)).toMatchObject({ receivedCount: 1, droppedVirusCount: 1 });
    const stored = await db.select().from(inboundMessages).where(eq(inboundMessages.domainId, fixture.domainId));
    expect(stored.map((row) => row.providerMessageId)).toEqual(["ses-spam"]);
    const delivered = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventType, "address.received"));
    expect(delivered).toHaveLength(1);
    expect((delivered[0]!.payload as { data: { flags: string[] } }).data.flags).toEqual(["spam"]);
    expect(await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventType, "inbound.received"))).toEqual([]);
    expect(sesBucket.size).toBe(0);
  });

  it("queues a forward for clean mail only: never spam, a virus or a DMARC failure", async () => {
    await setInbound({ enabled: true, webhook_url: "https://hooks.example.com/inbound", subdomain: "intake" });
    const id = await createAddress("abc123");
    await db.insert(addressForwardTargets).values({ id: "fwt_replay", organizationId: fixture.organizationId, addressId: id, email: "me@example.net", status: "confirmed" });
    const dmarcFail = (key: string) => {
      const objectKey = `inbound/${fixture.domainId}/${key}`;
      const raw = RAW.toString().replace(
        "X-SES-Spam-Verdict: PASS",
        "X-SES-Spam-Verdict: PASS\r\nAuthentication-Results: amazonses.com;\r\n spf=pass smtp.mailfrom=example.net;\r\n dkim=fail header.i=@example.net;\r\n dmarc=fail header.from=example.net;",
      );
      sesBucket.set(objectKey, Buffer.from(raw));
      return objectKey;
    };

    for (const key of [
      storedWith({ spam: "FAIL", virus: "PASS" }, "ses-spam"),
      storedWith({ spam: "PASS", virus: "FAIL" }, "ses-virus"),
      dmarcFail("ses-dmarc"),
      storedWith({ spam: "PASS", virus: "PASS" }, "ses-clean"),
    ]) {
      expect(await replay([fixture.providerId, key], () => {})).toBe(0);
    }

    const stored = await db.select().from(inboundMessages).where(eq(inboundMessages.domainId, fixture.domainId));
    expect(stored.find((row) => row.providerMessageId === "ses-dmarc")?.verdicts).toMatchObject({ dmarc: "fail", dkim: "fail", spf: "pass" });
    const forwards = await db.select({ inbound: inboundMessages.providerMessageId }).from(addressForwards).innerJoin(inboundMessages, eq(inboundMessages.id, addressForwards.inboundMessageId));
    expect(forwards).toEqual([{ inbound: "ses-clean" }]);
  });

  it("drops and counts mail replayed after the address expired", async () => {
    await setInbound({ enabled: true, webhook_url: "https://hooks.example.com/inbound", subdomain: "intake" });
    const id = await createAddress("abc123");
    await db.update(addresses).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(addresses.id, id));

    const lines: string[] = [];
    expect(await replay([fixture.providerId, stored(fixture.domainId, "ses-late")], (line) => lines.push(line))).toBe(0);

    expect(await counts(id)).toMatchObject({ receivedCount: 0, droppedExpiredCount: 1 });
    expect(await db.select().from(inboundMessages)).toEqual([]);
    expect(await db.select().from(webhookDeliveries)).toEqual([]);
    expect(sesBucket.size).toBe(0);
  });
});
