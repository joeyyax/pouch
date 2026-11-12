import { createSign } from "node:crypto";
import type { AwsCommandInput } from "../aws-command-input";
import { openProviderFindings } from "@/lib/reputation/provider-findings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { SNS_CERTIFICATE, SNS_PRIVATE_KEY } from "../fixtures/sns-certificate";
import { db } from "@/lib/db";
import { activity, domains, messages, organizations, providers, users } from "@/lib/db/schema";
import { decryptCredentials, listProviders, readProvider } from "@/lib/providers";
import { createSharedProvider, deleteProvider, rotateSharedCredentials, updateProvider } from "@/lib/providers/admin";
import { assignProvider, createSingleOrgProvider, setDefaultProvider, unassignProvider } from "@/lib/providers/assignment";
import { bootstrapProvider } from "@/scripts/bootstrap-provider";
import {
  listSharedProviders,
  listAssignmentBindings,
  offboardOrganization,
  onboardNewOrganization,
  onboardOrganization,
  setDefaultForNewOrganizations,
  tenantNameFor,
} from "@/lib/providers/shared";
import { readDefaultProviderId } from "@/lib/settings/service";
import { PROVIDER_PAUSED_REASON } from "@/lib/providers/tenant-status";
import { adapterFor, encryptCredentials, type ProviderRow } from "@/lib/providers";
import { userActor } from "@/lib/activity/record";
import { ApiError } from "@/lib/api/errors";
import { readSendingProvider } from "@/lib/dashboard/service";
import { listProviderOptions } from "@/lib/dashboard/domains";
import { adoptDomainForOrganization, createDomain, deleteDomain } from "@/lib/domains";
import { newId } from "@/lib/ids";
import { sendPushAlert } from "@/lib/notifications/push/push";
import { releaseOrganizationSuspension, suspendOrganization, suspensionOf } from "@/lib/suspension";
import { receive } from "@/lib/webhooks/receive";
import { dbNow } from "@/lib/db/clock";
import { acceptMessage } from "@/lib/messages/create";
import { claimMessages, dueProviders } from "@/lib/messages/queue";
import { deliver } from "@/worker/send";
import { API_RETRY, resetCertificateCache } from "@/lib/providers/adapters/ses";
import { errorResponse } from "@/lib/api/response";
import { createProviderAction } from "@/app/(app)/admin/settings/providers/actions";
import { assignProviderAction } from "@/app/(app)/admin/settings/organizations/actions";
import { providerRow, resetDatabase, seedFixture, seedSystemOrganization, type Fixture } from "./fixtures";

const { FakeCommand, aws } = vi.hoisted(() => {
  class FakeCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  const aws = {
    ses: [] as InstanceType<typeof FakeCommand>[],
    sns: [] as InstanceType<typeof FakeCommand>[],
    events: [] as InstanceType<typeof FakeCommand>[],
    tenants: new Map<string, { arn: string; status: string; suppression: unknown }>(),
    identities: new Map<string, { tags: { Key: string; Value: string }[]; verified?: boolean; mailFrom?: string }>(),
    associations: new Set<string>(),
    getTenantError: null as Error | null,
  };
  return { FakeCommand, aws };
});

function awsError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

const AWS_ACCOUNT_ID = "111122223333";
const REGION = "us-west-2";

function fakeSes(command: InstanceType<typeof FakeCommand>): unknown {
  aws.ses.push(command);
  const input = command.input as unknown as AwsCommandInput;
  switch (command.constructor.name) {
    case "GetAccountCommand":
      return { SendingEnabled: true };
    case "CreateTenantCommand": {
      if (aws.tenants.has(input.TenantName)) throw awsError("AlreadyExistsException");
      const arn = `arn:aws:ses:${REGION}:${AWS_ACCOUNT_ID}:tenant/${input.TenantName}/tn-${aws.tenants.size + 1}`;
      aws.tenants.set(input.TenantName, { arn, status: "ENABLED", suppression: input.SuppressionAttributes });
      return { TenantArn: arn, TenantName: input.TenantName };
    }
    case "GetTenantCommand": {
      if (aws.getTenantError) throw aws.getTenantError;
      const tenant = aws.tenants.get(input.TenantName);
      if (!tenant) throw awsError("NotFoundException");
      return { Tenant: { TenantName: input.TenantName, TenantArn: tenant.arn, SendingStatus: tenant.status } };
    }
    case "DeleteTenantCommand":
      if (!aws.tenants.delete(input.TenantName)) throw awsError("NotFoundException");
      return {};
    case "CreateTenantResourceAssociationCommand": {
      if (!aws.tenants.has(input.TenantName)) throw awsError("NotFoundException");
      const key = `${input.TenantName} ${input.ResourceArn}`;
      if (aws.associations.has(key)) throw awsError("AlreadyExistsException");
      aws.associations.add(key);
      return {};
    }
    case "DeleteTenantResourceAssociationCommand":
      if (!aws.associations.delete(`${input.TenantName} ${input.ResourceArn}`)) throw awsError("NotFoundException");
      return {};
    case "CreateEmailIdentityCommand": {
      if (aws.identities.has(input.EmailIdentity)) throw awsError("AlreadyExistsException");
      aws.identities.set(input.EmailIdentity, { tags: input.Tags ?? [] });
      return { DkimAttributes: { Tokens: ["tok1"] } };
    }
    case "GetEmailIdentityCommand": {
      const identity = aws.identities.get(input.EmailIdentity);
      if (!identity) throw awsError("NotFoundException");
      return {
        Tags: identity.tags,
        DkimAttributes: { Tokens: ["tok1"], Status: identity.verified ? "SUCCESS" : "PENDING" },
        VerifiedForSendingStatus: identity.verified === true,
        ...(identity.mailFrom ? { MailFromAttributes: { MailFromDomain: identity.mailFrom, MailFromDomainStatus: "SUCCESS" } } : {}),
      };
    }
    case "TagResourceCommand": {
      const name = String(input.ResourceArn).split("/").pop() ?? "";
      const identity = aws.identities.get(name);
      if (!identity) throw awsError("NotFoundException");
      identity.tags = [...identity.tags, ...(input.Tags ?? [])];
      return {};
    }
    case "DeleteEmailIdentityCommand": {
      const arnSuffix = `:identity/${input.EmailIdentity}`;
      if ([...aws.associations].some((key) => key.endsWith(arnSuffix))) throw awsError("ConflictException");
      aws.identities.delete(input.EmailIdentity);
      return {};
    }
    case "SendEmailCommand":
      return { MessageId: "ses-message-1" };
    default:
      return {};
  }
}

function client(send: (command: InstanceType<typeof FakeCommand>) => unknown) {
  return class {
    constructor(public readonly config: Record<string, unknown>) {}
    async send(command: InstanceType<typeof FakeCommand>) {
      return send(command);
    }
  };
}

vi.mock("@aws-sdk/client-sesv2", () => {
  const names = [
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
  ];
  return {
    SESv2Client: client((command) => fakeSes(command)),
    ...Object.fromEntries(names.map((name) => [name, { [name]: class extends FakeCommand {} }[name]])),
  };
});
vi.mock("@aws-sdk/client-sns", () => {
  const names = ["CreateTopicCommand", "SubscribeCommand", "ConfirmSubscriptionCommand", "SetTopicAttributesCommand", "DeleteTopicCommand"];
  return {
    SNSClient: client((command) => {
      aws.sns.push(command);
      if (command.constructor.name === "CreateTopicCommand") return { TopicArn: `arn:aws:sns:${REGION}:${AWS_ACCOUNT_ID}:${String(command.input.Name)}` };
      return {};
    }),
    ...Object.fromEntries(names.map((name) => [name, { [name]: class extends FakeCommand {} }[name]])),
  };
});
vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: client((command) => {
    aws.events.push(command);
    if (command.constructor.name === "PutRuleCommand") return { RuleArn: `arn:aws:events:${REGION}:${AWS_ACCOUNT_ID}:rule/${String(command.input.Name)}` };
    return { FailedEntryCount: 0 };
  }),
  PutRuleCommand: class PutRuleCommand extends FakeCommand {},
  PutTargetsCommand: class PutTargetsCommand extends FakeCommand {},
}));
vi.mock("@aws-sdk/client-sts", () => ({
  STSClient: client(() => ({ Account: AWS_ACCOUNT_ID })),
  GetCallerIdentityCommand: class GetCallerIdentityCommand extends FakeCommand {},
}));
vi.mock("@/lib/notifications/push/push", () => ({ sendPushAlert: vi.fn().mockResolvedValue(undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const sessionState = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth/session", async () => (await import("./fixtures")).adminSessionModule(sessionState));

const CREDENTIALS = { accessKeyId: "AKIASHARED", secretAccessKey: "shared-secret", region: REGION };
const CERT_URL = `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-1.pem`;
const operator = userActor("u_operator", "Olive");

let orgA: Fixture;
let orgB: Fixture;

beforeEach(async () => {
  await resetDatabase();
  aws.ses.length = 0;
  aws.sns.length = 0;
  aws.events.length = 0;
  aws.tenants.clear();
  aws.identities.clear();
  aws.associations.clear();
  sessionState.userId = null;
  vi.mocked(sendPushAlert).mockClear();
  await seedSystemOrganization();
  orgA = await seedFixture();
  orgB = await seedFixture();
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

function commandNames(list: InstanceType<typeof FakeCommand>[]): string[] {
  return list.map((command) => command.constructor.name);
}

async function shared(): Promise<ProviderRow> {
  const { provider } = await createSharedProvider({ adapter: "ses", name: "Hosted", credentials: CREDENTIALS }, operator);
  const [row] = await db.select().from(providers).where(eq(providers.id, provider.id));
  return row!;
}

function caller(fixture: Fixture) {
  return { organizationId: fixture.organizationId, domainIds: [], actor: userActor("u_1", "Ada") };
}

function snsRequest(topicArn: string, message: Record<string, string>): Request {
  const fields =
    message.Type === "Notification"
      ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
      : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  const full: Record<string, string> = { MessageId: crypto.randomUUID(), Timestamp: "2026-09-16T10:00:00.000Z", TopicArn: topicArn, ...message };
  const canonical = fields
    .filter((field) => full[field] !== undefined)
    .map((field) => `${field}\n${full[field]}\n`)
    .join("");
  const body = {
    ...full,
    SignatureVersion: "2",
    SigningCertURL: CERT_URL,
    Signature: createSign("RSA-SHA256").update(canonical, "utf8").sign(SNS_PRIVATE_KEY.trim(), "base64"),
  };
  return new Request("http://localhost/api/webhooks/ses/x", { method: "POST", body: JSON.stringify(body) });
}

function statusEvent(detailType: string, tenantArn: string, detail: Record<string, unknown> = {}): Record<string, string> {
  return {
    Type: "Notification",
    Message: JSON.stringify({ "detail-type": detailType, source: "aws.ses", provider: AWS_ACCOUNT_ID, resources: [tenantArn], detail }),
  };
}

/** Answers as the route does, so a thrown error becomes the status SNS sees. */
async function postStatus(provider: ProviderRow, detailType: string, tenantArn: string, detail: Record<string, unknown> = {}) {
  const response = await receive("ses", provider.id, snsRequest(provider.settings.topicArn!, statusEvent(detailType, tenantArn, detail))).catch(
    (err: unknown) => errorResponse(err),
  );
  return { status: response.status, body: (await response.json()) as Record<string, number> };
}

async function expectApiError(pending: Promise<unknown>, code: string): Promise<void> {
  const error = await pending.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe(code);
}

describe("shared provider", () => {
  it("lives in the system organization and reports tenant status through EventBridge to its own topic", async () => {
    const provider = await shared();

    expect(provider.shared).toBe(true);
    expect(provider.settings).toMatchObject({ sharing: "operator", topicArn: expect.stringContaining("mail-tenant-status-") });
    expect(provider.settings.eventRuleArn).toContain(":rule/");
    expect(commandNames(aws.events)).toEqual(["PutRuleCommand", "PutTargetsCommand"]);
    expect(aws.ses.map((c) => c.constructor.name)).toEqual(["GetAccountCommand"]);
    expect((await listSharedProviders())[0]?.configured).toBe(false);

    const confirm = await receive(
      "ses",
      provider.id,
      snsRequest(provider.settings.topicArn!, { Type: "SubscriptionConfirmation", Token: "tok", SubscribeURL: "https://sns.example", Message: "confirm" }),
    );
    expect(confirm.status).toBe(200);
    expect((await listSharedProviders())[0]?.configured).toBe(true);
  });

  it("refuses an adapter that can't hold tenants", async () => {
    await expectApiError(createSharedProvider({ adapter: "mock", name: "Nope", credentials: {} }, operator), "validation_failed");
  });

  it("is refused to anyone but an operator", async () => {
    const [user] = await db
      .insert(users)
      .values({ id: crypto.randomUUID(), organizationId: orgA.organizationId, name: "Member", email: "m@example.com" })
      .returning();
    sessionState.userId = user!.id;
    const form = new FormData();
    form.set("name", "Sneaky");
    await expect(createProviderAction({ status: "idle" }, form)).rejects.toThrow("Forbidden");

    const attach = new FormData();
    attach.set("id", orgA.organizationId);
    await expect(assignProviderAction({ status: "idle" }, attach)).rejects.toThrow("Forbidden");
    expect(await db.select().from(providers).where(eq(providers.shared, true))).toHaveLength(0);
  });

  it("replaces credentials on every tenant at once and leaves other providers alone", async () => {
    const provider = await shared();
    const { provider: tenant } = await onboardOrganization(provider.id, orgA.organizationId, operator);
    const before = decryptCredentials(await providerRow(orgB.providerId));

    await rotateSharedCredentials(provider.id, { ...CREDENTIALS, secretAccessKey: "rotated" }, operator);

    expect(decryptCredentials(await providerRow(provider.id)).secretAccessKey).toBe("rotated");
    expect(decryptCredentials(await providerRow(tenant.id)).secretAccessKey).toBe("rotated");
    expect(decryptCredentials(await providerRow(orgB.providerId))).toEqual(before);
  });

  it("onboards new organizations onto the one provider the default names", async () => {
    const first = await shared();
    const { provider: second } = await createSharedProvider({ adapter: "ses", name: "Hosted 2", credentials: CREDENTIALS }, operator);

    await onboardNewOrganization(orgA.organizationId);
    expect(await db.select().from(providers).where(eq(providers.organizationId, orgA.organizationId))).toHaveLength(1);

    await setDefaultForNewOrganizations(first.id);
    await setDefaultForNewOrganizations(second.id);
    expect(await readDefaultProviderId()).toBe(second.id);

    await onboardNewOrganization(orgA.organizationId);
    const [tenant] = await db
      .select()
      .from(providers)
      .where(and(eq(providers.organizationId, orgA.organizationId), eq(providers.sharedProviderId, second.id)));
    expect(tenant?.settings.tenantName).toBe(tenantNameFor(orgA.organizationId));
  });
});

async function assignedDefault(organizationId: string): Promise<string | null> {
  const [org] = await db.select({ id: organizations.providerId }).from(organizations).where(eq(organizations.id, organizationId));
  return org?.id ?? null;
}

/** An organization with nothing assigned. */
async function emptyOrganization(): Promise<string> {
  const id = newId("organization");
  await db.insert(organizations).values({ id, name: "Empty", slug: `empty-${id}` });
  return id;
}

describe("onboarding", () => {
  it("assigns the organization without calling the provider", async () => {
    const provider = await shared();
    const orgId = await emptyOrganization();
    await db.update(providers).set({ providerIdentity: AWS_ACCOUNT_ID }).where(eq(providers.id, provider.id));
    aws.ses.length = 0;
    aws.sns.length = 0;
    aws.events.length = 0;

    const { provider: tenant } = await onboardOrganization(provider.id, orgId, operator);

    expect([...aws.ses, ...aws.sns, ...aws.events]).toEqual([]);
    const stored = await providerRow(tenant.id);
    expect(stored).toMatchObject({ organizationId: orgId, sharedProviderId: provider.id, adapter: "ses", name: "Hosted", providerIdentity: AWS_ACCOUNT_ID });
    expect(stored.settings).toEqual({ tenantName: tenantNameFor(orgId), tenantState: "unrequested" });
    expect(decryptCredentials(stored)).toEqual(CREDENTIALS);
    expect(await assignedDefault(orgId)).toBe(tenant.id);
  });

  it("creates the tenant with its own suppression list on the first domain, then the configuration set, then associates both", async () => {
    const provider = await shared();
    const { provider: tenant } = await onboardOrganization(provider.id, orgA.organizationId, operator);
    aws.ses.length = 0;

    await createDomain(caller(orgA), { name: "first.example.com", provider_id: tenant.id });

    const name = tenantNameFor(orgA.organizationId);
    const tenantCalls = commandNames(aws.ses).filter((command) => /Tenant|ConfigurationSetCommand/.test(command));
    expect(tenantCalls).toEqual([
      "CreateTenantCommand",
      "CreateTenantResourceAssociationCommand",
      "CreateConfigurationSetCommand",
      "CreateTenantResourceAssociationCommand",
      "CreateConfigurationSetCommand",
    ]);
    expect(aws.tenants.get(name)?.suppression).toEqual({ SuppressionScope: "TENANT", SuppressedReasons: ["BOUNCE", "COMPLAINT"] });
    const stored = await providerRow(tenant.id);
    expect([...aws.associations].sort()).toEqual(
      [
        `${name} arn:aws:ses:${REGION}:${AWS_ACCOUNT_ID}:identity/first.example.com`,
        `${name} arn:aws:ses:${REGION}:${AWS_ACCOUNT_ID}:configuration-set/${String(stored.settings.configurationSetName)}`,
      ].sort(),
    );
    expect(stored.settings).toMatchObject({ tenantName: name, tenantArn: aws.tenants.get(name)?.arn, configurationSetAssociated: "true" });

    aws.ses.length = 0;
    await createDomain(caller(orgA), { name: "second.example.com", provider_id: tenant.id });
    expect(commandNames(aws.ses).filter((command) => command.includes("Tenant") && command !== "CreateTenantResourceAssociationCommand")).toEqual([]);
    expect(aws.tenants.size).toBe(1);
  });

  it("is safe to run again", async () => {
    const provider = await shared();
    const first = await onboardOrganization(provider.id, orgA.organizationId, operator);
    const again = await onboardOrganization(provider.id, orgA.organizationId, operator);

    const rows = await db.select().from(providers).where(eq(providers.sharedProviderId, provider.id));
    expect(rows).toHaveLength(1);
    expect(again).toEqual({ provider: first.provider, created: false });
    expect(await db.select().from(activity).where(eq(activity.action, "provider.shared.attached"))).toHaveLength(1);
  });

  it("names the provider apart from one the organization already has", async () => {
    await db.update(providers).set({ name: "Hosted" }).where(eq(providers.id, orgA.providerId));
    const provider = await shared();

    const { provider: tenant } = await onboardOrganization(provider.id, orgA.organizationId, operator);

    expect(tenant.name).toBe("Hosted (2)");
  });

  it("attaches an organization as a tenant, on the provider new organizations join too", async () => {
    const provider = await shared();
    await setDefaultForNewOrganizations(provider.id);
    const orgId = await emptyOrganization();

    const { provider: tenant } = await onboardOrganization(provider.id, orgId, operator);

    expect(tenant).toMatchObject({ organizationId: orgId, sharedProviderId: provider.id });
    expect(tenant.settings.tenantName).toBe(tenantNameFor(orgId));
  });

  it("reads an assignment with no domains as set up, and one with an unfinished domain as not", async () => {
    const provider = await shared();
    const { provider: tenant } = await onboardOrganization(provider.id, orgA.organizationId, operator);
    expect((await listAssignmentBindings()).find((binding) => binding.providerId === tenant.id)?.configured).toBe(true);

    await db.insert(domains).values({ id: newId("domain"), organizationId: orgA.organizationId, providerId: tenant.id, name: "half.example.com", status: "pending" });

    expect((await listAssignmentBindings()).find((binding) => binding.providerId === tenant.id)?.configured).toBe(false);
  });

  it("copies the credentials current at insert, not the ones read before a rotation", async () => {
    const provider = await shared();
    const orgId = await emptyOrganization();
    const rotated = encryptCredentials({ ...CREDENTIALS, secretAccessKey: "rotated" });

    // Holds the insert until the rotation commits.
    let onboarding: Promise<unknown> = Promise.resolve();
    await db.transaction(async (tx) => {
      await tx.execute(sql`lock table providers in share mode`);
      onboarding = onboardOrganization(provider.id, orgId, operator);
      onboarding.catch(() => {});
      let blocked = false;
      for (let i = 0; i < 300 && !blocked; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const waiting = await tx.execute(sql`select 1 from pg_locks where relation = 'providers'::regclass and not granted`);
        blocked = waiting.length > 0;
      }
      expect(blocked).toBe(true);
      await tx.update(providers).set({ credentials: rotated }).where(eq(providers.id, provider.id));
    });
    await onboarding;

    const [tenant] = await db.select().from(providers).where(eq(providers.organizationId, orgId));
    expect(decryptCredentials(tenant!).secretAccessKey).toBe("rotated");
  });

  it("sends with the tenant's name and configuration set", async () => {
    const provider = await shared();
    const { provider: tenant } = await onboardOrganization(provider.id, orgA.organizationId, operator);
    await createDomain(caller(orgA), { name: "send.example.com", provider_id: tenant.id });
    const stored = await providerRow(tenant.id);
    aws.ses.length = 0;

    await adapterFor(stored).send({
      id: "msg_1",
      from: { name: null, address: "ada@send.example.com" },
      to: ["person@example.net"],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: "Hi",
      html: "<p>Hi</p>",
      text: null,
      headers: {},
      tags: [],
      attachments: [],
    });

    expect(stored.settings.configurationSetName).toBeTruthy();
    expect(aws.ses[0]?.input).toMatchObject({
      TenantName: tenantNameFor(orgA.organizationId),
      ConfigurationSetName: stored.settings.configurationSetName,
    });
  });
});

describe("assignment", () => {
  it("adds providers alongside the default, which moves only when asked", async () => {
    const provider = await shared();
    const { provider: other } = await createSharedProvider({ adapter: "ses", name: "Other", credentials: CREDENTIALS }, operator);
    await db.update(organizations).set({ providerId: orgA.providerId }).where(eq(organizations.id, orgA.organizationId));

    const added = await assignProvider(provider.id, orgA.organizationId, operator);
    expect(await assignedDefault(orgA.organizationId)).toBe(orgA.providerId);

    const third = await assignProvider(other.id, orgA.organizationId, operator, { default: true });
    expect(await assignedDefault(orgA.organizationId)).toBe(third.id);

    await expect(assignProvider(provider.id, orgA.organizationId, operator)).resolves.toMatchObject({ id: added.id });
    expect(await db.select().from(providers).where(eq(providers.sharedProviderId, provider.id))).toHaveLength(1);
  });

  it("assigns an empty organization and sets its default, with no provider call", async () => {
    const provider = await shared();
    const orgId = await emptyOrganization();
    aws.ses.length = 0;

    const tenant = await assignProvider(provider.id, orgId, operator);

    expect(aws.ses).toEqual([]);
    expect(await assignedDefault(orgId)).toBe(tenant.id);
  });

  it("keeps a provider without tenants to the organization it was created in", async () => {
    const orgId = await emptyOrganization();
    const { provider } = await createSingleOrgProvider({ adapter: "mock", name: "Own", credentials: {} }, orgId, operator);
    expect(await assignedDefault(orgId)).toBe(provider.id);

    await expectApiError(assignProvider(provider.id, orgB.organizationId, operator), "validation_failed");
    await expectApiError(unassignProvider(provider.id, orgId, operator), "validation_failed");
    await expect(createSingleOrgProvider({ adapter: "mock", name: "Second", credentials: {} }, orgId, operator)).resolves.toBeTruthy();
    expect(await assignedDefault(orgId)).toBe(provider.id);
    await expectApiError(createSingleOrgProvider({ adapter: "ses", name: "Shared", credentials: CREDENTIALS }, await emptyOrganization(), operator), "validation_failed");
  });

  it("sets the default only to one of the organization's own assignments", async () => {
    await expectApiError(setDefaultProvider(orgA.organizationId, orgB.providerId, operator), "not_found");

    await setDefaultProvider(orgA.organizationId, orgA.providerId, operator);

    expect(await assignedDefault(orgA.organizationId)).toBe(orgA.providerId);
    const [changed] = await db.select().from(activity).where(eq(activity.action, "provider.default.changed"));
    expect(changed).toMatchObject({ organizationId: orgA.organizationId, appliesTo: orgA.providerId });
  });

  it("clears the default when the assignment is removed", async () => {
    const provider = await shared();
    const orgId = await emptyOrganization();
    await assignProvider(provider.id, orgId, operator);

    await unassignProvider(provider.id, orgId, operator);

    expect(await assignedDefault(orgId)).toBeNull();
    expect(await db.select().from(providers).where(eq(providers.organizationId, orgId))).toEqual([]);
  });

  it("gives a new organization the default provider when one is set, and nothing otherwise", async () => {
    const provider = await shared();
    const unmarked = await emptyOrganization();
    await onboardNewOrganization(unmarked);
    expect(await assignedDefault(unmarked)).toBeNull();

    await setDefaultForNewOrganizations(provider.id);
    const marked = await emptyOrganization();
    aws.ses.length = 0;
    await onboardNewOrganization(marked);

    expect(aws.ses).toEqual([]);
    const [tenant] = await db.select().from(providers).where(eq(providers.organizationId, marked));
    expect(await assignedDefault(marked)).toBe(tenant!.id);
  });

  it("puts an organization on a tenant of the default provider, never on the provider row", async () => {
    const provider = await shared();
    await setDefaultForNewOrganizations(provider.id);
    const orgId = await emptyOrganization();

    const tenant = await assignProvider(provider.id, orgId, operator, { default: true });

    expect(tenant).toMatchObject({ organizationId: orgId, sharedProviderId: provider.id, shared: false });
    expect(await assignedDefault(orgId)).toBe(tenant.id);
    await expectApiError(setDefaultProvider(orgId, provider.id, operator), "not_found");
    expect(await assignedDefault(orgId)).toBe(tenant.id);
  });
});

describe("bootstrap", () => {
  const base = { adapter: "ses", name: "primary", credentials: CREDENTIALS, settings: {}, concurrency: 4 };

  it("puts two organizations on one shared provider when the credentials match", async () => {
    const orgId = await emptyOrganization();
    const otherId = await emptyOrganization();

    const first = await bootstrapProvider({ ...base, organizationId: orgId });
    const ours = await bootstrapProvider({ ...base, organizationId: otherId, name: "ours" });

    expect(first.parent).toMatchObject({ organizationId: null, shared: true });
    expect(ours.parent?.id).toBe(first.parent?.id);
    expect(ours.provider).toMatchObject({ organizationId: otherId, name: "ours", sharedProviderId: first.parent?.id });
    expect(await assignedDefault(orgId)).toBe(first.provider.id);
    expect(await assignedDefault(otherId)).toBe(ours.provider.id);
    expect(aws.tenants.size).toBe(0);

    const again = await bootstrapProvider({ ...base, organizationId: orgId });
    expect(again.provider.id).toBe(first.provider.id);
  });

  it("gives other credentials their own shared provider", async () => {
    const first = await bootstrapProvider({ ...base, organizationId: await emptyOrganization() });
    const second = await bootstrapProvider({ ...base, organizationId: await emptyOrganization(), credentials: { ...CREDENTIALS, accessKeyId: "AKIAOTHER" } });

    expect(second.parent?.id).not.toBe(first.parent?.id);
  });

  it("keeps an organization's existing provider, whatever its name", async () => {
    const result = await bootstrapProvider({ ...base, organizationId: orgA.organizationId, name: "unrelated" });

    expect(result).toEqual({ provider: expect.objectContaining({ id: orgA.providerId }), parent: null });
    expect(await assignedDefault(orgA.organizationId)).toBe(orgA.providerId);
  });
});

describe("isolation", () => {
  it("lists the organization's tenant provider, never the credentials, settings or the shared provider", async () => {
    const provider = await shared();
    const { provider: tenant } = await onboardOrganization(provider.id, orgA.organizationId, operator);

    const page = await listProviders(caller(orgA), 50);
    const listed = page.data.find((item) => item.id === tenant.id);
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty("settings");
    expect(JSON.stringify(page)).not.toContain("shared-secret");
    expect(JSON.stringify(page)).not.toContain(provider.id);
    expect(page.data.find((item) => item.id === orgA.providerId)).toBeDefined();

    const single = await readProvider(caller(orgA), tenant.id);
    expect(single).not.toHaveProperty("settings");
    expect(single).not.toHaveProperty("credentials");
    expect(JSON.stringify(single)).not.toContain("shared-secret");

    const sending = await readSendingProvider(orgA.organizationId);
    expect(sending?.adminProviderId).toBe(provider.id);
    expect(JSON.stringify(sending)).not.toContain("shared-secret");
  });

  it("keeps the shared provider out of every organization's own lists and reads", async () => {
    const provider = await shared();
    const orgId = await emptyOrganization();
    const caller = { organizationId: orgId, domainIds: [], actor: operator };

    const page = await listProviders(caller, 50);
    expect(page.data.map((item) => item.id)).not.toContain(provider.id);
    expect((await listProviderOptions(orgId)).map((item) => item.id)).not.toContain(provider.id);
    await expectApiError(readProvider(caller, provider.id), "not_found");
    await expectApiError(updateProvider(caller, provider.id, { credentials: { ...CREDENTIALS, secretAccessKey: "x" } }), "not_found");
    await expectApiError(createDomain(caller, { name: "ops.example.com", provider_id: provider.id }), "not_found");
  });

  it("refuses an organization's changes to its managed provider and keeps the stored credentials", async () => {
    const provider = await shared();
    const { provider: tenant } = await onboardOrganization(provider.id, orgA.organizationId, operator);
    const before = (await providerRow(tenant.id)).credentials;

    await expectApiError(updateProvider(caller(orgA), tenant.id, { credentials: { ...CREDENTIALS, secretAccessKey: "mine" } }), "validation_failed");
    await expectApiError(updateProvider(caller(orgA), tenant.id, { settings: { configurationSetName: "other" } }), "validation_failed");
    await expectApiError(deleteProvider(caller(orgA), tenant.id), "validation_failed");

    const after = await providerRow(tenant.id);
    expect(after.credentials).toBe(before);
    expect(after.settings.configurationSetName).toBe(tenant.settings.configurationSetName);
  });

  it("never lets one organization read another's tenant provider", async () => {
    const provider = await shared();
    const { provider: tenantB } = await onboardOrganization(provider.id, orgB.organizationId, operator);

    await expectApiError(readProvider(caller(orgA), tenantB.id), "not_found");
    await expectApiError(createDomain(caller(orgA), { name: "a.example.com", provider_id: tenantB.id }), "not_found");
  });

  it("refuses a domain another tenant on the shared provider already holds", async () => {
    const provider = await shared();
    const { provider: tenantA } = await onboardOrganization(provider.id, orgA.organizationId, operator);
    const { provider: tenantB } = await onboardOrganization(provider.id, orgB.organizationId, operator);

    await createDomain(caller(orgA), { name: "brand.example.com", provider_id: tenantA.id });
    const nameA = tenantNameFor(orgA.organizationId);
    expect(aws.identities.get("brand.example.com")?.tags).toEqual([{ Key: "mail-tenant", Value: nameA }]);
    expect(aws.associations).toContain(`${nameA} arn:aws:ses:${REGION}:${AWS_ACCOUNT_ID}:identity/brand.example.com`);

    await expectApiError(createDomain(caller(orgB), { name: "brand.example.com", provider_id: tenantB.id }), "domain_unavailable");
    expect([...aws.associations].filter((key) => key.includes("identity/brand.example.com"))).toHaveLength(1);
    expect(await db.select().from(domains).where(eq(domains.organizationId, orgB.organizationId))).toHaveLength(1);
  });
});

describe("adopting an identity SES already holds", () => {
  /** An identity from before tagging: verified, sending, and no tags at all. */
  function preexisting(name: string, extra: { mailFrom?: string } = {}): void {
    aws.identities.set(name, { tags: [], verified: true, ...extra });
  }

  it("tags an untagged identity for the organization's tenant and keeps its DKIM", async () => {
    const provider = await shared();
    const { provider: tenant } = await onboardOrganization(provider.id, orgA.organizationId, operator);
    preexisting("pouch.email");
    aws.ses.length = 0;

    const domain = await adoptDomainForOrganization(
      { name: "pouch.email", organization_id: orgA.organizationId, provider_id: tenant.id },
      operator,
    );

    // The identity is never recreated, so the DKIM CNAMEs already published stay valid.
    expect(commandNames(aws.ses)).not.toContain("CreateEmailIdentityCommand");
    expect(aws.identities.get("pouch.email")?.tags).toEqual([{ Key: "mail-tenant", Value: tenantNameFor(orgA.organizationId) }]);
    expect(aws.associations).toContain(`${tenantNameFor(orgA.organizationId)} arn:aws:ses:${REGION}:${AWS_ACCOUNT_ID}:identity/pouch.email`);
    expect(domain.dns_records.filter((record) => record.type === "CNAME").map((record) => record.name)).toEqual(["tok1._domainkey.pouch.email"]);
    // Already sending at SES, so the row lands verified rather than waiting on records.
    expect(domain.status).toBe("verified");

    const [row] = await db.select().from(domains).where(eq(domains.organizationId, orgA.organizationId)).orderBy(sql`created_at desc`).limit(1);
    expect(row?.providerId).toBe(tenant.id);
    const [logged] = await db.select().from(activity).where(eq(activity.action, "domain.adopted"));
    expect(logged?.organizationId).toBe(orgA.organizationId);
  });

  it("leaves an existing MAIL FROM domain alone", async () => {
    const provider = await shared();
    const { provider: tenant } = await onboardOrganization(provider.id, orgA.organizationId, operator);
    preexisting("pouch.email", { mailFrom: "bounces.pouch.email" });
    aws.ses.length = 0;

    const domain = await adoptDomainForOrganization(
      { name: "pouch.email", organization_id: orgA.organizationId, provider_id: tenant.id },
      operator,
    );

    expect(commandNames(aws.ses)).not.toContain("PutEmailIdentityMailFromAttributesCommand");
    expect(domain.dns_records.filter((record) => record.type !== "CNAME" && !record.name.startsWith("_dmarc.")).map((record) => record.name)).toEqual([
      "bounces.pouch.email",
      "bounces.pouch.email",
    ]);
  });

  it("refuses an identity tagged for another tenant", async () => {
    const provider = await shared();
    const { provider: tenantA } = await onboardOrganization(provider.id, orgA.organizationId, operator);
    const { provider: tenantB } = await onboardOrganization(provider.id, orgB.organizationId, operator);
    await createDomain(caller(orgB), { name: "brand.example.com", provider_id: tenantB.id });
    aws.ses.length = 0;

    await expectApiError(
      adoptDomainForOrganization({ name: "brand.example.com", organization_id: orgA.organizationId, provider_id: tenantA.id }, operator),
      "domain_unavailable",
    );
    expect(commandNames(aws.ses)).not.toContain("TagResourceCommand");
    expect(commandNames(aws.ses)).not.toContain("CreateTenantResourceAssociationCommand");
    expect(commandNames(aws.ses)).not.toContain("PutEmailIdentityMailFromAttributesCommand");
    expect(aws.identities.get("brand.example.com")?.tags).toEqual([{ Key: "mail-tenant", Value: tenantNameFor(orgB.organizationId) }]);
    expect(await db.select().from(domains).where(eq(domains.organizationId, orgA.organizationId))).toHaveLength(1);
  });

  it("keeps answering domain_unavailable for an organization adding the same domain itself", async () => {
    const provider = await shared();
    const { provider: tenant } = await onboardOrganization(provider.id, orgA.organizationId, operator);
    preexisting("pouch.email");

    // Adoption is admin-only: an organization key has no path to it.
    await expectApiError(createDomain(caller(orgA), { name: "pouch.email", provider_id: tenant.id }), "domain_unavailable");
    expect(aws.identities.get("pouch.email")?.tags).toEqual([]);
  });

  it("refuses a domain SES has no identity for", async () => {
    const provider = await shared();
    const { provider: tenant } = await onboardOrganization(provider.id, orgA.organizationId, operator);
    aws.ses.length = 0;

    await expectApiError(
      adoptDomainForOrganization({ name: "nothing.example.com", organization_id: orgA.organizationId, provider_id: tenant.id }, operator),
      "domain_not_at_provider",
    );
    expect(commandNames(aws.ses)).not.toContain("TagResourceCommand");
  });

  it("refuses an organization that doesn't exist", async () => {
    const provider = await shared();
    const { provider: tenant } = await onboardOrganization(provider.id, orgA.organizationId, operator);
    preexisting("pouch.email");

    await expectApiError(
      adoptDomainForOrganization({ name: "pouch.email", organization_id: "org_missing", provider_id: tenant.id }, operator),
      "not_found",
    );
  });
});

describe("offboarding", () => {
  it("is refused while a domain uses the provider, and detaches the identity first when the domain goes", async () => {
    const provider = await shared();
    const { provider: tenant } = await onboardOrganization(provider.id, orgA.organizationId, operator);
    const domain = await createDomain(caller(orgA), { name: "leaving.example.com", provider_id: tenant.id });

    await expectApiError(offboardOrganization(provider.id, orgA.organizationId, operator), "provider_in_use");

    await deleteDomain(caller(orgA), domain.id);
    expect(aws.identities.has("leaving.example.com")).toBe(false);

    await offboardOrganization(provider.id, orgA.organizationId, operator);
    expect(aws.tenants.size).toBe(0);
    expect(aws.associations.size).toBe(0);
    expect(await db.select().from(providers).where(eq(providers.sharedProviderId, provider.id))).toHaveLength(0);
    const [detached] = await db.select().from(activity).where(eq(activity.action, "provider.shared.detached"));
    expect(detached?.organizationId).toBe(orgA.organizationId);

    await expect(offboardOrganization(provider.id, orgA.organizationId, operator)).resolves.toBeUndefined();
  });

  it("makes no provider call for an organization that never added a domain", async () => {
    const provider = await shared();
    const orgId = await emptyOrganization();
    await assignProvider(provider.id, orgId, operator);
    aws.ses.length = 0;
    aws.sns.length = 0;

    await unassignProvider(provider.id, orgId, operator);

    expect(aws.ses).toEqual([]);
    expect(aws.sns).toEqual([]);
    expect(await db.select().from(providers).where(eq(providers.organizationId, orgId))).toEqual([]);
  });

  it("still deletes a tenant whose first domain failed before its ARN was stored", async () => {
    const provider = await shared();
    const { provider: tenant } = await onboardOrganization(provider.id, orgA.organizationId, operator);
    // Fails the identity association, after CreateTenant and before anything stores the ARN.
    aws.associations.add = () => {
      throw awsError("InternalFailure");
    };
    try {
      await expect(createDomain(caller(orgA), { name: "halfway.example.com", provider_id: tenant.id })).rejects.toThrow();
    } finally {
      aws.associations.add = Set.prototype.add;
    }
    expect(aws.tenants.has(tenantNameFor(orgA.organizationId))).toBe(true);
    expect((await providerRow(tenant.id)).settings.tenantArn).toBeUndefined();

    await offboardOrganization(provider.id, orgA.organizationId, operator);

    expect(aws.tenants.size).toBe(0);
  });
});

describe("tenant status", () => {
  async function attached() {
    const provider = await shared();
    const { provider: tenant } = await onboardOrganization(provider.id, orgA.organizationId, operator);
    await createDomain(caller(orgA), { name: "status.example.com", provider_id: tenant.id });
    const name = tenantNameFor(orgA.organizationId);
    return { provider: await providerRow(provider.id), tenant: await providerRow(tenant.id), name, arn: aws.tenants.get(name)!.arn };
  }

  const disabledDetail = { version: "1.0.0", data: { origin: "AWS_MANAGED", record: { status: "DISABLED", cause: "Bounce rate." } } };

  it("suspends the organization when SES pauses its tenant", async () => {
    const { provider, name, arn } = await attached();
    aws.tenants.get(name)!.status = "DISABLED";

    const result = await postStatus(provider, "Sending Status Disabled", arn, disabledDetail);

    expect(result).toEqual({ status: 200, body: { applied: 1, ignored: 0 } });
    const suspension = await suspensionOf(orgA.organizationId);
    expect(suspension).toMatchObject({ source: "provider", reason: PROVIDER_PAUSED_REASON });
    expect(suspension?.detail).toMatchObject({ tenant: name, origin: "AWS_MANAGED", cause: "Bounce rate." });
    expect(await suspensionOf(orgB.organizationId)).toBeNull();

    const again = await postStatus(provider, "Sending Status Disabled", arn, disabledDetail);
    expect(again.status).toBe(200);
    const rows = await db.select().from(activity).where(eq(activity.action, "organization.suspended"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorType).toBe("provider");
  });

  describe("when the status read fails", () => {
    const retryDefaults = { ...API_RETRY };
    beforeEach(() => {
      API_RETRY.baseMs = 1;
      aws.getTenantError = Object.assign(new Error("Too many requests."), { name: "TooManyRequestsException", $metadata: { httpStatusCode: 429 } });
    });
    afterEach(() => {
      Object.assign(API_RETRY, retryDefaults);
      aws.getTenantError = null;
    });

    it("answers a pause with a status SNS redelivers, and suspends on the redelivery", async () => {
      const { provider, name, arn } = await attached();
      aws.tenants.get(name)!.status = "ENABLED";

      const failed = await postStatus(provider, "Sending Status Disabled", arn, disabledDetail);

      expect(failed.status).toBe(503);
      expect(await suspensionOf(orgA.organizationId)).toBeNull();

      aws.getTenantError = null;
      aws.tenants.get(name)!.status = "DISABLED";
      const redelivered = await postStatus(provider, "Sending Status Disabled", arn, disabledDetail);

      expect(redelivered).toEqual({ status: 200, body: { applied: 1, ignored: 0 } });
      expect((await suspensionOf(orgA.organizationId))?.source).toBe("provider");
    });

    it("answers a re-enable with a status SNS redelivers, and keeps the suspension until it reads", async () => {
      const { provider, name, arn } = await attached();
      await suspendOrganization(orgA.organizationId, { source: "provider", reason: PROVIDER_PAUSED_REASON }, operator);
      aws.tenants.get(name)!.status = "REINSTATED";

      const failed = await postStatus(provider, "Sending Status Enabled", arn);

      expect(failed.status).toBe(503);
      expect((await suspensionOf(orgA.organizationId))?.source).toBe("provider");
    });
  });

  it("still suspends when SES no longer has the tenant", async () => {
    const { provider, name, arn } = await attached();
    aws.tenants.delete(name);

    const result = await postStatus(provider, "Sending Status Disabled", arn, disabledDetail);

    expect(result).toEqual({ status: 200, body: { applied: 1, ignored: 0 } });
    expect((await suspensionOf(orgA.organizationId))?.source).toBe("provider");
  });

  it("ignores a pause the provider has already lifted", async () => {
    const { provider, arn } = await attached();

    const result = await postStatus(provider, "Sending Status Disabled", arn, disabledDetail);

    expect(result.body).toEqual({ applied: 0, ignored: 1 });
    expect(await suspensionOf(orgA.organizationId)).toBeNull();
  });

  it("releases its own suspension when SES re-enables the tenant", async () => {
    const { provider, name, arn } = await attached();
    aws.tenants.get(name)!.status = "DISABLED";
    await postStatus(provider, "Sending Status Disabled", arn, disabledDetail);

    aws.tenants.get(name)!.status = "REINSTATED";
    const result = await postStatus(provider, "Sending Status Enabled", arn);

    expect(result.body).toEqual({ applied: 1, ignored: 0 });
    expect(await suspensionOf(orgA.organizationId)).toBeNull();
  });

  it("holds the organization's queued mail through a pause and sends it on release", async () => {
    const { provider, name, arn } = await attached();
    const { message } = await acceptMessage(
      orgA.key,
      { from: "ada@example.com", to: ["person@example.net"], subject: "Reset your password", html: "<p>Hi</p>" },
      null,
    );
    const drain = async () => {
      await db.update(messages).set({ nextAttemptAt: await dbNow() }).where(eq(messages.id, message.id));
      for (const due of await dueProviders()) {
        for (const claimed of await claimMessages({ workerId: "worker-a", providerId: due.id, limit: 50 })) {
          await deliver(claimed, "worker-a");
        }
      }
      const [found] = await db.select().from(messages).where(eq(messages.id, message.id));
      return found!;
    };

    aws.tenants.get(name)!.status = "DISABLED";
    await postStatus(provider, "Sending Status Disabled", arn, disabledDetail);
    const held = await drain();
    expect(held).toMatchObject({ status: "queued", attempts: 0, failureReason: null });

    aws.tenants.get(name)!.status = "REINSTATED";
    await postStatus(provider, "Sending Status Enabled", arn);
    expect(await drain()).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("leaves an operator's suspension in place when SES re-enables the tenant", async () => {
    const { provider, arn } = await attached();
    await suspendOrganization(orgA.organizationId, { source: "manual", reason: "Phishing." }, operator);

    await postStatus(provider, "Sending Status Enabled", arn);

    expect((await suspensionOf(orgA.organizationId))?.source).toBe("manual");
  });

  it("doesn't release on an enable event while the tenant is still paused", async () => {
    const { provider, name, arn } = await attached();
    aws.tenants.get(name)!.status = "DISABLED";
    await postStatus(provider, "Sending Status Disabled", arn, disabledDetail);

    const result = await postStatus(provider, "Sending Status Enabled", arn);

    expect(result.body).toEqual({ applied: 0, ignored: 1 });
    expect((await suspensionOf(orgA.organizationId))?.source).toBe("provider");
  });

  it("records a reputation finding without suspending, and alerts on a high-impact one", async () => {
    const { provider, tenant, arn } = await attached();

    await postStatus(provider, "Advisor Recommendation Status Open", arn, {
      version: "1.0.0",
      data: "The bounce rate exceeded 15.0%.",
      metadata: { impact: "HIGH", type: "BOUNCE" },
    });

    expect(await suspensionOf(orgA.organizationId)).toBeNull();
    const [finding] = await db.select().from(activity).where(eq(activity.action, "provider.finding.opened"));
    expect(finding).toMatchObject({ organizationId: orgA.organizationId, appliesTo: tenant.id });
    expect(finding?.metadata).toMatchObject({ impact: "HIGH", type: "BOUNCE", description: "The bounce rate exceeded 15.0%." });
    expect(await openProviderFindings(orgA.organizationId)).toEqual([
      { providerId: tenant.id, type: "BOUNCE", impact: "HIGH", description: "The bounce rate exceeded 15.0%." },
    ]);
    expect(sendPushAlert).toHaveBeenCalledTimes(1);
  });

  it("doesn't log or alert again when SNS delivers the same finding twice", async () => {
    const { provider, arn } = await attached();
    const detail = { version: "1.0.0", data: "The bounce rate exceeded 15.0%.", metadata: { impact: "HIGH", type: "BOUNCE" } };

    await postStatus(provider, "Advisor Recommendation Status Open", arn, detail);
    await postStatus(provider, "Advisor Recommendation Status Open", arn, detail);

    expect(await db.select().from(activity).where(eq(activity.action, "provider.finding.opened"))).toHaveLength(1);
    expect(sendPushAlert).toHaveBeenCalledTimes(1);
  });

  it("matches a tenant by name when the event's ARN is shaped differently", async () => {
    const { provider, name } = await attached();
    aws.tenants.get(name)!.status = "DISABLED";

    await postStatus(provider, "Sending Status Disabled", `arn:aws:ses:${REGION}:${AWS_ACCOUNT_ID}:tenant/${name}/tn-other`);

    expect((await suspensionOf(orgA.organizationId))?.source).toBe("provider");
  });

  it("ignores a tenant that isn't on this provider", async () => {
    const { provider } = await attached();
    const { provider: other } = await createSharedProvider({ adapter: "ses", name: "Other", credentials: CREDENTIALS }, operator);
    const { provider: foreign } = await onboardOrganization(other.id, orgB.organizationId, operator);
    await createDomain(caller(orgB), { name: "foreign.example.com", provider_id: foreign.id });
    const foreignRow = await providerRow(foreign.id);
    aws.tenants.get(foreignRow.settings.tenantName!)!.status = "DISABLED";

    const result = await postStatus(provider, "Sending Status Disabled", foreignRow.settings.tenantArn!);

    expect(result.body).toEqual({ applied: 0, ignored: 1 });
    expect(await suspensionOf(orgB.organizationId)).toBeNull();
  });

  it("refuses a status event signed for another topic", async () => {
    const { provider, name, arn } = await attached();
    aws.tenants.get(name)!.status = "DISABLED";

    await expectApiError(
      receive("ses", provider.id, snsRequest(`${provider.settings.topicArn}-x`, statusEvent("Sending Status Disabled", arn))),
      "invalid_signature",
    );
    expect(await suspensionOf(orgA.organizationId)).toBeNull();
  });

  it("never reads status from a tenant's own event route", async () => {
    const { tenant, name, arn } = await attached();
    aws.tenants.get(name)!.status = "DISABLED";
    const assignmentRow = await db
      .update(providers)
      .set({ settings: { ...tenant.settings, subscriptionConfirmed: "true" } })
      .where(eq(providers.id, tenant.id))
      .returning();

    await receive("ses", tenant.id, snsRequest(assignmentRow[0]!.settings.topicArn!, statusEvent("Sending Status Disabled", arn)));

    expect(await suspensionOf(orgA.organizationId)).toBeNull();
  });

  it("releases only the source it's asked to", async () => {
    await suspendOrganization(orgA.organizationId, { source: "manual", reason: "Hold." }, operator);
    expect(await releaseOrganizationSuspension(orgA.organizationId, operator, undefined, { onlySource: "provider" })).toBe(false);
    expect((await suspensionOf(orgA.organizationId))?.source).toBe("manual");
  });
});

describe("self-hosted install", () => {
  it("keeps ordinary providers unmanaged and editable", async () => {
    const id = newId("provider");
    await db.insert(providers).values({
      id,
      organizationId: orgA.organizationId,
      adapter: "mock",
      name: "own",
      credentials: encryptCredentials({}),
    });

    const updated = await updateProvider(caller(orgA), id, { name: "renamed" });
    expect(updated).toMatchObject({ name: "renamed" });
    await expect(deleteProvider(caller(orgA), id)).resolves.toEqual({ id, deleted: true });
  });
});
