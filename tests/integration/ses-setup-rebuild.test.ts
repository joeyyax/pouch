import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, messages, providers } from "@/lib/db/schema";
import { encryptCredentials, type ProviderRow } from "@/lib/providers";
import { recordProviderProbe } from "@/lib/health/checks";
import { newId } from "@/lib/ids";
import { acceptMessage } from "@/lib/messages/create";
import { claimMessages } from "@/lib/messages/queue";
import { sendPushAlert } from "@/lib/notifications/push/push";
import { API_RETRY } from "@/lib/providers/adapters/ses";
import { deliver } from "@/worker/send";
import { awsError, providerRow, resetDatabase, seedFixture, seedSystemOrganization, type Fixture } from "./fixtures";
import type { AwsCommandInput } from "../aws-command-input";

vi.mock("@/lib/notifications/push/push", () => ({ sendPushAlert: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/health/checks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/health/checks")>();
  return { ...actual, recordProviderProbe: vi.fn(actual.recordProviderProbe) };
});

const REGION = "us-west-2";
const AWS_ACCOUNT_ID = "111122223333";

const { aws } = vi.hoisted(() => ({
  aws: {
    calls: [] as string[],
    tenants: new Map<string, string>(),
    configSets: new Set<string>(),
    /** `${tenant} ${resourceArn}` */
    associations: new Set<string>(),
    identities: new Map<string, { Key: string; Value: string }[]>(),
    fail: new Map<string, Error>(),
    arns: 0,
  },
}));

function fakeSes(name: string, input: AwsCommandInput): unknown {
  aws.calls.push(name);
  const failure = aws.fail.get(name);
  if (failure) throw failure;
  switch (name) {
    case "SendEmailCommand":
      if (input.TenantName && !aws.tenants.has(input.TenantName)) throw awsError("NotFoundException", 404);
      if (input.ConfigurationSetName && !aws.configSets.has(input.ConfigurationSetName)) throw awsError("NotFoundException", 404);
      return { MessageId: "ses-1" };
    case "GetTenantCommand": {
      const arn = aws.tenants.get(input.TenantName);
      if (!arn) throw awsError("NotFoundException", 404);
      return { Tenant: { TenantName: input.TenantName, TenantArn: arn, SendingStatus: "ENABLED" } };
    }
    case "CreateTenantCommand": {
      if (aws.tenants.has(input.TenantName)) throw awsError("AlreadyExistsException", 400);
      aws.arns += 1;
      const arn = `arn:aws:ses:${REGION}:${AWS_ACCOUNT_ID}:tenant/${input.TenantName}/tn-new-${aws.arns}`;
      aws.tenants.set(input.TenantName, arn);
      return { TenantArn: arn, TenantName: input.TenantName };
    }
    case "GetConfigurationSetCommand":
      if (!aws.configSets.has(input.ConfigurationSetName)) throw awsError("NotFoundException", 404);
      return { ConfigurationSetName: input.ConfigurationSetName };
    case "CreateConfigurationSetCommand":
      if (aws.configSets.has(input.ConfigurationSetName)) throw awsError("AlreadyExistsException", 400);
      aws.configSets.add(input.ConfigurationSetName);
      return {};
    case "CreateTenantResourceAssociationCommand": {
      const key = `${input.TenantName} ${input.ResourceArn}`;
      if (aws.associations.has(key)) throw awsError("AlreadyExistsException", 400);
      aws.associations.add(key);
      return {};
    }
    case "CreateEmailIdentityCommand":
      if (aws.identities.has(input.EmailIdentity)) throw awsError("AlreadyExistsException", 400);
      return { DkimAttributes: { Tokens: ["t1"] } };
    case "GetEmailIdentityCommand":
      return { Tags: aws.identities.get(input.EmailIdentity) ?? [], DkimAttributes: { Tokens: ["t1"] } };
    default:
      return {};
  }
}

vi.mock("@aws-sdk/client-sesv2", () => {
  class FakeCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  const names = [
    "SendEmailCommand",
    "GetAccountCommand",
    "GetTenantCommand",
    "CreateTenantCommand",
    "PutTenantSuppressionAttributesCommand",
    "GetConfigurationSetCommand",
    "CreateConfigurationSetCommand",
    "CreateConfigurationSetEventDestinationCommand",
    "CreateTenantResourceAssociationCommand",
    "CreateEmailIdentityCommand",
    "GetEmailIdentityCommand",
    "PutEmailIdentityMailFromAttributesCommand",
  ];
  return {
    SESv2Client: class {
      async send(command: FakeCommand) {
        return fakeSes(command.constructor.name, command.input as unknown as AwsCommandInput);
      }
    },
    ...Object.fromEntries(names.map((name) => [name, { [name]: class extends FakeCommand {} }[name]])),
  };
});

vi.mock("@aws-sdk/client-sns", () => {
  class FakeCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  return {
    SNSClient: class {
      async send(command: FakeCommand) {
        aws.calls.push(command.constructor.name);
        if (command.constructor.name === "CreateTopicCommand") return { TopicArn: TOPIC_ARN };
        return {};
      }
    },
    ...Object.fromEntries(
      ["CreateTopicCommand", "SubscribeCommand", "SetTopicAttributesCommand", "ConfirmSubscriptionCommand", "DeleteTopicCommand"].map((name) => [
        name,
        { [name]: class extends FakeCommand {} }[name],
      ]),
    ),
  };
});

const TOPIC_ARN = `arn:aws:sns:${REGION}:${AWS_ACCOUNT_ID}:mail-events`;
const CREDENTIALS = { accessKeyId: "AKIA", secretAccessKey: "secret", region: REGION };

let fixture: Fixture;
let tenantName: string;
let configSet: string;
const oldTenantArn = () => `arn:aws:ses:${REGION}:${AWS_ACCOUNT_ID}:tenant/${tenantName}/tn-old`;

const provider = (): Promise<ProviderRow> => providerRow(fixture.providerId);

async function messageStatus(id: string): Promise<string> {
  const [row] = await db.select().from(messages).where(eq(messages.id, id));
  return row!.status;
}

/** Queues one message and delivers it, clearing any backoff first so it can be claimed. */
async function sendOnce(): Promise<string> {
  await db.update(providers).set({ backoffUntil: null }).where(eq(providers.id, fixture.providerId));
  const { message } = await acceptMessage(fixture.key, { from: "Ada <ada@example.com>", to: ["person@example.net"], subject: "Hi", html: "<p>Hi</p>" }, null);
  const [claimed] = await claimMessages({ workerId: "w", providerId: fixture.providerId, limit: 1 });
  await deliver(claimed!, "w");
  return message.id;
}

async function asTenant(): Promise<void> {
  await seedSystemOrganization();
  const sharedId = newId("provider");
  await db.insert(providers).values({
    id: sharedId,
    adapter: "ses",
    name: "Hosted",
    credentials: encryptCredentials(CREDENTIALS),
    shared: true,
    settings: { sharing: "operator" },
  });
  tenantName = `tenant-${fixture.organizationId}`;
  await db
    .update(providers)
    .set({
      sharedProviderId: sharedId,
      settings: {
        tenantName,
        tenantArn: oldTenantArn(),
        configurationSetName: configSet,
        configurationSetAssociated: "true",
        topicArn: TOPIC_ARN,
        subscriptionConfirmed: "true",
      },
    })
    .where(eq(providers.id, fixture.providerId));
  aws.tenants.set(tenantName, oldTenantArn());
  aws.associations.add(`${tenantName} arn:aws:ses:${REGION}:${AWS_ACCOUNT_ID}:identity/example.com`);
  aws.associations.add(`${tenantName} arn:aws:ses:${REGION}:${AWS_ACCOUNT_ID}:configuration-set/${configSet}`);
  aws.identities.set("example.com", [{ Key: "mail-tenant", Value: tenantName }]);
}

const retryDefaults = { ...API_RETRY };

beforeEach(async () => {
  await resetDatabase();
  API_RETRY.baseMs = 1;
  aws.calls.length = 0;
  aws.tenants.clear();
  aws.configSets.clear();
  aws.associations.clear();
  aws.identities.clear();
  aws.fail.clear();
  vi.mocked(sendPushAlert).mockClear();
  vi.mocked(recordProviderProbe).mockClear();
  fixture = await seedFixture({ providerAdapter: "ses", credentials: CREDENTIALS });
  await db.update(domains).set({ providerDomainId: "example.com" }).where(eq(domains.id, fixture.domainId));
  configSet = `mail-events-${fixture.providerId.replace(/[^a-zA-Z0-9]+/g, "-")}`;
  aws.configSets.add(configSet);
});
afterEach(() => {
  Object.assign(API_RETRY, retryDefaults);
});

describe("a tenant whose configuration set SES no longer has", () => {
  beforeEach(asTenant);

  it("holds the message, rebuilds the configuration set and tells the operator", async () => {
    aws.configSets.delete(configSet);
    aws.associations.delete(`${tenantName} arn:aws:ses:${REGION}:${AWS_ACCOUNT_ID}:configuration-set/${configSet}`);

    const id = await sendOnce();

    expect(await messageStatus(id)).toBe("queued");
    const row = await provider();
    expect(row.backoffUntil).not.toBeNull();
    expect(aws.configSets.has(configSet)).toBe(true);
    expect(aws.associations.has(`${tenantName} arn:aws:ses:${REGION}:${AWS_ACCOUNT_ID}:configuration-set/${configSet}`)).toBe(true);
    expect(row.settings).toMatchObject({ tenantArn: oldTenantArn(), configurationSetName: configSet, configurationSetAssociated: "true" });
    expect(row.settings.rebuild || null).toBeNull();
    expect(sendPushAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendPushAlert).mock.calls[0]![0].message).toContain("configuration set");
    expect(recordProviderProbe).toHaveBeenCalledWith(row.id, "ses", expect.objectContaining({ ok: false }), expect.anything());

    expect(await messageStatus(await sendOnce())).toBe("sent");
  });
});

describe("a tenant SES no longer has", () => {
  beforeEach(asTenant);

  it("holds the message, recreates the tenant and re-associates its identities", async () => {
    aws.tenants.delete(tenantName);
    aws.associations.clear();

    const id = await sendOnce();

    expect(await messageStatus(id)).toBe("queued");
    const newArn = aws.tenants.get(tenantName);
    expect(newArn).toContain("tn-new-");
    const row = await provider();
    expect(row.settings).toMatchObject({ tenantArn: newArn, configurationSetAssociated: "true" });
    expect(aws.associations).toContain(`${tenantName} arn:aws:ses:${REGION}:${AWS_ACCOUNT_ID}:identity/example.com`);
    expect(aws.associations).toContain(`${tenantName} arn:aws:ses:${REGION}:${AWS_ACCOUNT_ID}:configuration-set/${configSet}`);
    expect(sendPushAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendPushAlert).mock.calls[0]![0].message).toContain("tenant");

    expect(await messageStatus(await sendOnce())).toBe("sent");
  });

  it("keeps the rebuild pending when it fails, retries it on the next held send, and alerts once", async () => {
    aws.tenants.delete(tenantName);
    aws.fail.set("CreateTenantCommand", awsError("InternalFailure", 500));

    const first = await sendOnce();

    expect(await messageStatus(first)).toBe("queued");
    expect((await provider()).settings.rebuild).toBe("tenant");

    aws.fail.clear();
    const second = await sendOnce();

    expect(await messageStatus(second)).toBe("queued");
    expect(aws.tenants.has(tenantName)).toBe(true);
    expect((await provider()).settings.rebuild || null).toBeNull();
    expect(sendPushAlert).toHaveBeenCalledTimes(1);
  });
});

describe("a NotFoundException that isn't a lost resource", () => {
  beforeEach(asTenant);

  it("fails the message and rebuilds nothing", async () => {
    aws.fail.set("SendEmailCommand", awsError("NotFoundException", 404));

    const id = await sendOnce();

    expect(await messageStatus(id)).toBe("failed");
    expect((await provider()).backoffUntil).toBeNull();
    expect((await provider()).settings.rebuild || null).toBeNull();
    expect(aws.calls).not.toContain("CreateConfigurationSetCommand");
    expect(sendPushAlert).not.toHaveBeenCalled();
  });

  it("retries the message when SES can't say what's missing", async () => {
    aws.fail.set("SendEmailCommand", awsError("NotFoundException", 404));
    aws.fail.set("GetTenantCommand", awsError("TooManyRequestsException", 429));

    const id = await sendOnce();

    expect(await messageStatus(id)).toBe("queued");
    expect((await provider()).backoffUntil).toBeNull();
    expect((await provider()).settings.rebuild || null).toBeNull();
    expect(sendPushAlert).not.toHaveBeenCalled();
  });
});

describe("an ordinary provider whose configuration set SES no longer has", () => {
  it("holds the message and rebuilds it under the same name", async () => {
    await db
      .update(providers)
      .set({ settings: { configurationSetName: configSet, topicArn: TOPIC_ARN, subscriptionConfirmed: "true" } })
      .where(eq(providers.id, fixture.providerId));
    aws.configSets.delete(configSet);

    const id = await sendOnce();

    expect(await messageStatus(id)).toBe("queued");
    expect(aws.configSets.has(configSet)).toBe(true);
    expect(aws.calls).toContain("CreateConfigurationSetEventDestinationCommand");
    expect((await provider()).settings).toMatchObject({ configurationSetName: configSet, subscriptionConfirmed: "true" });
    expect(sendPushAlert).toHaveBeenCalledTimes(1);

    expect(await messageStatus(await sendOnce())).toBe("sent");
  });
});
