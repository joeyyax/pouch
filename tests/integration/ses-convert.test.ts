import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, domains, providers } from "@/lib/db/schema";
import { encryptCredentials, type ProviderRow } from "@/lib/providers";
import { ConversionStoppedError, MissingPermissionsError, convertToTenant, planConversion } from "@/lib/providers/convert";
import { tenantNameFor } from "@/lib/providers/shared";
import { workerActor } from "@/lib/activity/record";
import { ApiError } from "@/lib/api/errors";
import { newId } from "@/lib/ids";
import { acceptMessage } from "@/lib/messages/create";
import { claimMessages } from "@/lib/messages/queue";
import { isConfiguredFor } from "@/lib/providers/adapters";
import { API_RETRY } from "@/lib/providers/adapters/ses";
import { deliver } from "@/worker/send";
import { main as convertScript } from "@/scripts/convert-provider";
import { addDomainKeyFor, awsError, providerRow, resetDatabase, seedFixture, seedSystemOrganization, type Fixture } from "./fixtures";
import type { AwsCommandInput } from "../aws-command-input";

const REGION = "us-west-2";
const AWS_ACCOUNT_ID = "111122223333";
const USER_ARN = `arn:aws:iam::${AWS_ACCOUNT_ID}:user/pouch`;

interface Failure {
  /** Successful calls allowed before this one fails. */
  after: number;
  error: Error;
}

const { aws } = vi.hoisted(() => ({
  aws: {
    calls: [] as string[],
    sends: [] as { TenantName?: string; ConfigurationSetName?: string }[],
    tenants: new Map<string, string>(),
    configSets: new Set<string>(),
    /** `${tenant} ${resourceArn}` */
    associations: new Set<string>(),
    identities: new Map<string, { Key: string; Value: string }[]>(),
    /** Keyed by tenant name, "" for the provider list. */
    suppressed: new Map<string, Map<string, string>>(),
    denied: new Set<string>(),
    simulateDenied: false,
    fail: new Map<string, Failure>(),
    counts: new Map<string, number>(),
    arns: 0,
  },
}));

function record(name: string): void {
  aws.calls.push(name);
  const count = aws.counts.get(name) ?? 0;
  const failure = aws.fail.get(name);
  if (failure && count >= failure.after) throw failure.error;
  aws.counts.set(name, count + 1);
}

function suppressionList(tenant: string | undefined): Map<string, string> {
  const key = tenant ?? "";
  if (!aws.suppressed.has(key)) aws.suppressed.set(key, new Map());
  return aws.suppressed.get(key)!;
}

const identityArn = (name: string) => `arn:aws:ses:${REGION}:${AWS_ACCOUNT_ID}:identity/${name}`;
const configSetArn = (name: string) => `arn:aws:ses:${REGION}:${AWS_ACCOUNT_ID}:configuration-set/${name}`;

function fakeSes(name: string, input: AwsCommandInput): unknown {
  record(name);
  switch (name) {
    case "SendEmailCommand": {
      const from = String(input.Content?.Raw.Data).match(/^From: .*@([^>\s]+)/m)?.[1] ?? "";
      if (input.TenantName) {
        // SES validates that a tenant send uses resources associated with that tenant.
        if (!aws.tenants.has(input.TenantName)) throw awsError("NotFoundException", 404);
        if (!aws.associations.has(`${input.TenantName} ${identityArn(from)}`)) throw awsError("BadRequestException", 400);
        if (!aws.associations.has(`${input.TenantName} ${configSetArn(input.ConfigurationSetName)}`)) throw awsError("BadRequestException", 400);
      }
      aws.sends.push({ TenantName: input.TenantName, ConfigurationSetName: input.ConfigurationSetName });
      return { MessageId: `ses-${aws.sends.length}` };
    }
    case "GetTenantCommand": {
      const arn = aws.tenants.get(input.TenantName);
      if (!arn) throw awsError("NotFoundException", 404);
      return { Tenant: { TenantName: input.TenantName, TenantArn: arn, SendingStatus: "ENABLED" } };
    }
    case "CreateTenantCommand": {
      if (aws.tenants.has(input.TenantName)) throw awsError("AlreadyExistsException", 400);
      aws.arns += 1;
      const arn = `arn:aws:ses:${REGION}:${AWS_ACCOUNT_ID}:tenant/${input.TenantName}/tn-${aws.arns}`;
      aws.tenants.set(input.TenantName, arn);
      return { TenantArn: arn, TenantName: input.TenantName };
    }
    case "CreateTenantResourceAssociationCommand": {
      const key = `${input.TenantName} ${input.ResourceArn}`;
      if (aws.associations.has(key)) throw awsError("AlreadyExistsException", 400);
      aws.associations.add(key);
      return {};
    }
    case "GetEmailIdentityCommand": {
      const tags = aws.identities.get(input.EmailIdentity);
      if (!tags) throw awsError("NotFoundException", 404);
      return { Tags: tags };
    }
    case "TagResourceCommand": {
      const identity = String(input.ResourceArn).split("identity/")[1] ?? "";
      const tags = aws.identities.get(identity);
      if (!tags) throw awsError("NotFoundException", 404);
      for (const tag of input.Tags ?? []) {
        aws.identities.set(identity, [...(aws.identities.get(identity) ?? []).filter((entry) => entry.Key !== tag.Key), tag]);
      }
      return {};
    }
    case "ListSuppressedDestinationsCommand": {
      const entries = [...suppressionList(input.TenantName).entries()];
      const start = Number(input.NextToken ?? 0);
      const size = 2;
      const page = entries.slice(start, start + size);
      return {
        SuppressedDestinationSummaries: page.map(([address, reason]) => ({ EmailAddress: address, Reason: reason })),
        NextToken: start + size < entries.length ? String(start + size) : undefined,
      };
    }
    case "PutSuppressedDestinationCommand":
      suppressionList(input.TenantName).set(input.EmailAddress, input.Reason);
      return {};
    default:
      return {};
  }
}

function commandModule(names: string[], handle: (name: string, input: AwsCommandInput) => unknown, client: string) {
  class FakeCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  return {
    [client]: class {
      async send(command: FakeCommand) {
        return handle(command.constructor.name, command.input as unknown as AwsCommandInput);
      }
    },
    ...Object.fromEntries(names.map((name) => [name, { [name]: class extends FakeCommand {} }[name]])),
  };
}

// The script loads .env, which would bring back the REDIS_URL tests run without.
vi.mock("@/lib/env", () => ({}));

vi.mock("@aws-sdk/client-sesv2", () =>
  commandModule(
    [
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
      "TagResourceCommand",
      "ListSuppressedDestinationsCommand",
      "PutSuppressedDestinationCommand",
    ],
    fakeSes,
    "SESv2Client",
  ),
);

vi.mock("@aws-sdk/client-sns", () =>
  commandModule(
    ["CreateTopicCommand", "SubscribeCommand", "SetTopicAttributesCommand", "ConfirmSubscriptionCommand", "DeleteTopicCommand"],
    (name, input) => {
      record(name);
      return name === "CreateTopicCommand" ? { TopicArn: `arn:aws:sns:${REGION}:${AWS_ACCOUNT_ID}:${input.Name}` } : {};
    },
    "SNSClient",
  ),
);

vi.mock("@aws-sdk/client-eventbridge", () =>
  commandModule(
    ["PutRuleCommand", "PutTargetsCommand"],
    (name, input) => {
      record(name);
      return name === "PutRuleCommand" ? { RuleArn: `arn:aws:events:${REGION}:${AWS_ACCOUNT_ID}:rule/${input.Name}` } : { FailedEntryCount: 0 };
    },
    "EventBridgeClient",
  ),
);

vi.mock("@aws-sdk/client-sts", () =>
  commandModule(
    ["GetCallerIdentityCommand"],
    (name) => {
      record(name);
      return { Account: AWS_ACCOUNT_ID, Arn: USER_ARN };
    },
    "STSClient",
  ),
);

vi.mock("@aws-sdk/client-iam", () =>
  commandModule(
    ["SimulatePrincipalPolicyCommand"],
    (name, input) => {
      record(name);
      if (aws.simulateDenied) throw awsError("AccessDenied", 403);
      if (input.PolicySourceArn !== USER_ARN) throw awsError("NoSuchEntity", 404);
      return {
        EvaluationResults: input.ActionNames.map((action) => ({
          EvalActionName: action,
          EvalDecision: aws.denied.has(action) ? "implicitDeny" : "allowed",
        })),
        IsTruncated: false,
      };
    },
    "IAMClient",
  ),
);

const CREDENTIALS = { accessKeyId: "AKIA", secretAccessKey: "secret", region: REGION };

let fixture: Fixture;
let configSet: string;
let tenantName: string;

const row = (id = fixture.providerId): Promise<ProviderRow> => providerRow(id);

async function parents(): Promise<ProviderRow[]> {
  return db.select().from(providers).where(eq(providers.shared, true));
}

/** Queues one message and delivers it through the worker, returning the SES send it made. */
async function sendOnce(): Promise<{ TenantName?: string; ConfigurationSetName?: string }> {
  const before = aws.sends.length;
  await acceptMessage(fixture.key, { from: "Ada <ada@example.com>", to: ["person@example.net"], subject: "Hi", html: "<p>Hi</p>" }, null);
  const [claimed] = await claimMessages({ workerId: "w", providerId: fixture.providerId, limit: 1 });
  await deliver(claimed!, "w");
  expect(aws.sends).toHaveLength(before + 1);
  return aws.sends[before]!;
}

/** A legacy SES row as production has it: its own configuration set and topic, no tenant. */
async function legacyProvider(target: Fixture, identity = "example.com"): Promise<string> {
  const set = `mail-events-${target.providerId.replace(/[^a-zA-Z0-9]+/g, "-")}`;
  await db
    .update(providers)
    .set({
      providerIdentity: AWS_ACCOUNT_ID,
      settings: { configurationSetName: set, topicArn: `arn:aws:sns:${REGION}:${AWS_ACCOUNT_ID}:${set}`, subscriptionConfirmed: "true" },
    })
    .where(eq(providers.id, target.providerId));
  await db.update(domains).set({ name: identity, providerDomainId: identity }).where(eq(domains.id, target.domainId));
  if (!aws.identities.has(identity)) aws.identities.set(identity, [{ Key: "mail-account", Value: target.providerId }]);
  aws.configSets.add(set);
  return set;
}

const convert = (id = fixture.providerId) => convertToTenant(id, { actor: workerActor("test") });

beforeEach(async () => {
  await resetDatabase();
  API_RETRY.baseMs = 1;
  aws.calls.length = 0;
  aws.sends.length = 0;
  aws.tenants.clear();
  aws.configSets.clear();
  aws.associations.clear();
  aws.identities.clear();
  aws.suppressed.clear();
  aws.denied.clear();
  aws.simulateDenied = false;
  aws.fail.clear();
  aws.counts.clear();
  await seedSystemOrganization();
  fixture = await seedFixture({ providerAdapter: "ses", credentials: CREDENTIALS });
  configSet = await legacyProvider(fixture);
  tenantName = tenantNameFor(fixture.organizationId);
  // One identity tagged when it was created, one from before tagging.
  aws.identities.set("example.com", [{ Key: "mail-account", Value: fixture.providerId }]);
  aws.identities.set("old.example.org", []);
  await addDomainKeyFor(fixture, fixture.providerId, "old.example.org");
  suppressionList(undefined).set("bounced@example.net", "BOUNCE");
  suppressionList(undefined).set("complained@example.net", "COMPLAINT");
  suppressionList(undefined).set("gone@example.net", "BOUNCE");
});

function expectConverted(converted: ProviderRow, parent: ProviderRow): void {
  expect(converted.sharedProviderId).toBe(parent.id);
  expect(converted.credentials).toBe(parent.credentials);
  expect(converted.settings).toMatchObject({
    tenantName,
    tenantArn: aws.tenants.get(tenantName),
    configurationSetAssociated: "true",
    configurationSetName: configSet,
  });
  expect(converted.settings.conversionStep).toBeUndefined();
  expect(isConfiguredFor("ses", converted.settings)).toBe(true);
}

describe("converting a legacy SES account", () => {
  it("creates the parent and tenant, moves the existing resources and flips the row last", async () => {
    const result = await convert();

    expect(result.converted).toBe(true);
    expect(result.reached).toBe("flip");
    expect(result.suppressionsCopied).toBe(3);

    const [parent] = await parents();
    expect(parent).toMatchObject({ organizationId: null, adapter: "ses", providerIdentity: AWS_ACCOUNT_ID, shared: true, name: "primary" });
    expect(parent!.settings).toMatchObject({ sharing: "operator", eventRuleArn: expect.stringContaining("rule/") });
    expect(parent!.settings.topicArn).toContain(`mail-tenant-status-`);

    expectConverted(await row(), parent!);
    expect(aws.tenants.has(tenantName)).toBe(true);
    expect(aws.associations).toEqual(
      new Set([
        `${tenantName} ${configSetArn(configSet)}`,
        `${tenantName} ${identityArn("example.com")}`,
        `${tenantName} ${identityArn("old.example.org")}`,
      ]),
    );
    expect(aws.identities.get("example.com")).toEqual([
      { Key: "mail-account", Value: fixture.providerId },
      { Key: "mail-tenant", Value: tenantName },
    ]);
    expect(aws.identities.get("old.example.org")).toEqual([{ Key: "mail-tenant", Value: tenantName }]);
    expect([...suppressionList(tenantName).entries()]).toEqual([...suppressionList(undefined).entries()]);
    // Nothing was recreated.
    expect(aws.calls).not.toContain("CreateConfigurationSetCommand");
    expect(aws.calls).not.toContain("CreateEmailIdentityCommand");

    const events = await db
      .select()
      .from(activity)
      .where(and(eq(activity.organizationId, fixture.organizationId), eq(activity.action, "provider.shared.converted")));
    expect(events).toHaveLength(1);
    expect(events[0]!.appliesTo).toBe(fixture.providerId);
  });

  it("makes only the calls its dry run lists", async () => {
    const lines: string[] = [];
    await convertToTenant(fixture.providerId, { actor: workerActor(), dryRun: true, log: (line) => lines.push(line) });
    const listed = lines.join("\n");

    await convert();

    for (const call of new Set(aws.calls)) expect(listed).toContain(call);
  });

  it("reuses the parent on the same AWS account and skips its setup", async () => {
    await convert();
    const second = await seedFixture({ providerAdapter: "ses", credentials: CREDENTIALS });
    await legacyProvider(second, "second.example");
    aws.calls.length = 0;

    await convert(second.providerId);

    const all = await parents();
    expect(all).toHaveLength(1);
    expect((await row(second.providerId)).sharedProviderId).toBe(all[0]!.id);
    expect(aws.calls).not.toContain("PutRuleCommand");
    expect(aws.calls).not.toContain("CreateTopicCommand");
  });

  it("does nothing on a row that's already converted", async () => {
    await convert();
    aws.calls.length = 0;

    const again = await convert();

    expect(again.converted).toBe(true);
    expect(aws.calls).toEqual([]);
  });

  it("refuses a row whose AWS account isn't known yet", async () => {
    await db.update(providers).set({ providerIdentity: null }).where(eq(providers.id, fixture.providerId));

    await expect(convert()).rejects.toThrow(/no known provider identity/);
    expect(aws.calls).toEqual([]);
  });

  it("refuses an organization that already has an assignment row on the parent", async () => {
    await convert();
    const second = await seedFixture({ providerAdapter: "ses", credentials: CREDENTIALS });
    await legacyProvider(second, "second.example");
    const [parent] = await parents();
    await db.insert(providers).values({
      id: newId("provider"),
      organizationId: second.organizationId,
      adapter: "ses",
      name: "tenant",
      credentials: encryptCredentials(CREDENTIALS),
      settings: { tenantName: tenantNameFor(second.organizationId) },
      sharedProviderId: parent!.id,
    });
    aws.calls.length = 0;

    await expect(convert(second.providerId)).rejects.toThrow(ApiError);
    expect(aws.calls).toEqual([]);
  });

  it("stops before associating an identity another provider holds", async () => {
    aws.identities.set("old.example.org", [{ Key: "mail-account", Value: "pac_someone_else" }]);

    const error = await convert().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ConversionStoppedError);
    expect((error as ConversionStoppedError).stage).toBe("associate");
    expect(aws.associations).toEqual(new Set());
    expect((await row()).sharedProviderId).toBeNull();
  });

  it("refuses a second organization's binding to an identity the first tenant now holds", async () => {
    await convert();
    const second = await seedFixture({ providerAdapter: "ses", credentials: CREDENTIALS });
    await legacyProvider(second);

    const error = await convert(second.providerId).catch((err: unknown) => err);

    expect((error as ConversionStoppedError).stage).toBe("associate");
    expect([...aws.associations].filter((key) => key.startsWith(tenantNameFor(second.organizationId)))).toEqual([]);
  });
});

describe("a rerun after a failure", () => {
  const cases: { stage: string; command: string; after?: number }[] = [
    { stage: "parent_setup", command: "PutRuleCommand" },
    { stage: "tenant", command: "CreateTenantCommand" },
    { stage: "associate", command: "CreateTenantResourceAssociationCommand", after: 1 },
    { stage: "tag", command: "TagResourceCommand", after: 1 },
    { stage: "suppression", command: "PutSuppressedDestinationCommand", after: 2 },
  ];

  it.each(cases)("resumes after a failure in $stage", async ({ stage, command, after = 0 }) => {
    aws.fail.set(command, { after, error: awsError("InternalFailure", 500) });

    const error = await convert().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ConversionStoppedError);
    expect((error as ConversionStoppedError).stage).toBe(stage);
    const stopped = await row();
    expect(stopped.sharedProviderId).toBeNull();
    expect(stopped.settings.tenantName).toBeUndefined();
    expect((await sendOnce()).TenantName).toBeUndefined();

    aws.fail.clear();
    const before = new Map(aws.counts);
    await convert();

    const [parent] = await parents();
    expect(await parents()).toHaveLength(1);
    expectConverted(await row(), parent!);
    // Finished stages aren't repeated.
    const madeAgain = (name: string) => (aws.counts.get(name) ?? 0) - (before.get(name) ?? 0);
    if (stage !== "parent_setup") expect(madeAgain("PutRuleCommand")).toBe(0);
    if (!["parent_setup", "tenant"].includes(stage)) expect(madeAgain("CreateTenantCommand") + madeAgain("GetTenantCommand")).toBe(0);
    if (["tag", "suppression"].includes(stage)) expect(madeAgain("CreateTenantResourceAssociationCommand")).toBe(0);
    if (stage === "suppression") {
      expect(madeAgain("TagResourceCommand")).toBe(0);
      expect(madeAgain("PutSuppressedDestinationCommand")).toBe(1);
    }
    expect(suppressionList(tenantName).size).toBe(3);
    expect((await sendOnce()).TenantName).toBe(tenantName);
  });
});

describe("a dry run", () => {
  it("lists every call and makes none", async () => {
    const lines: string[] = [];
    const result = await convertToTenant(fixture.providerId, { actor: workerActor(), dryRun: true, log: (line) => lines.push(line) });

    expect(aws.calls).toEqual([]);
    expect(await parents()).toEqual([]);
    const unchanged = await row();
    expect(unchanged.sharedProviderId).toBeNull();
    expect(unchanged.settings.tenantArn).toBeUndefined();
    expect(result.converted).toBe(false);
    const output = lines.join("\n");
    for (const call of ["SimulatePrincipalPolicyCommand", "PutRuleCommand", "CreateTenantCommand", "TagResourceCommand", "PutSuppressedDestinationCommand"]) {
      expect(output).toContain(call);
    }
    expect(output).toContain(`DB insert shared provider "primary"`);
    expect(output).toContain("events:PutRule");
  });

  it("marks the stages a failed run already finished", async () => {
    aws.fail.set("TagResourceCommand", { after: 0, error: awsError("InternalFailure", 500) });
    await convert().catch(() => {});
    aws.calls.length = 0;

    const plan = await planConversion(fixture.providerId);

    expect(plan.stages.filter((stage) => stage.done).map((stage) => stage.stage)).toEqual(["parent", "parent_setup", "tenant", "associate"]);
    expect(plan.permissions).not.toContain("events:PutRule");
    expect(aws.calls).toEqual([]);
  });
});

describe("the permission check", () => {
  it("stops before changing anything and names what's missing", async () => {
    aws.denied.add("events:PutRule");
    aws.denied.add("events:PutTargets");

    const error = await convert().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MissingPermissionsError);
    expect((error as MissingPermissionsError).missing).toEqual(["events:PutRule", "events:PutTargets"]);
    expect(aws.calls).toEqual(["GetCallerIdentityCommand", "SimulatePrincipalPolicyCommand"]);
    expect(await parents()).toEqual([]);
    expect((await row()).settings.tenantArn).toBeUndefined();
  });

  it("reports its own permission when the credentials can't run the check", async () => {
    aws.simulateDenied = true;

    const error = await convert().catch((err: unknown) => err);

    expect((error as MissingPermissionsError).missing).toEqual(["iam:SimulatePrincipalPolicy"]);
    expect(await parents()).toEqual([]);
  });

  it("doesn't ask for EventBridge once the parent is set up", async () => {
    await convert();
    const second = await seedFixture({ providerAdapter: "ses", credentials: CREDENTIALS });
    await legacyProvider(second, "second.example");
    aws.denied.add("events:PutRule");
    aws.denied.add("events:PutTargets");

    const result = await convert(second.providerId);

    expect(result.converted).toBe(true);
  });

  it("prints the list from the script and exits 1", async () => {
    aws.denied.add("ses:PutSuppressedDestination");
    const lines: string[] = [];

    const code = await convertScript([fixture.providerId], (line) => lines.push(line));

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("stopped before changing anything");
    expect(lines).toContain("  ses:PutSuppressedDestination");
  });
});

describe("sends across the conversion", () => {
  it("carry no tenant name until the row flips, then the tenant's", async () => {
    const before = await sendOnce();
    expect(before).toEqual({ TenantName: undefined, ConfigurationSetName: configSet });

    // Stopped after association, which is where the sending gap would be.
    aws.fail.set("TagResourceCommand", { after: 0, error: awsError("InternalFailure", 500) });
    await convert().catch(() => {});
    expect(aws.associations.has(`${tenantName} ${identityArn("example.com")}`)).toBe(true);
    expect(await sendOnce()).toEqual({ TenantName: undefined, ConfigurationSetName: configSet });

    aws.fail.clear();
    await convert();
    expect(await sendOnce()).toEqual({ TenantName: tenantName, ConfigurationSetName: configSet });
  });

  it("are refused by SES when the tenant name is set before association", async () => {
    const [parentless] = await db.select().from(providers).where(eq(providers.id, fixture.providerId));
    aws.tenants.set(tenantName, `arn:aws:ses:${REGION}:${AWS_ACCOUNT_ID}:tenant/${tenantName}/tn-0`);
    await db
      .update(providers)
      .set({ settings: { ...parentless!.settings, tenantName } })
      .where(eq(providers.id, fixture.providerId));
    const before = aws.sends.length;

    await acceptMessage(fixture.key, { from: "ada@example.com", to: ["person@example.net"], subject: "Hi", html: "<p>Hi</p>" }, null);
    const [claimed] = await claimMessages({ workerId: "w", providerId: fixture.providerId, limit: 1 });
    await deliver(claimed!, "w");

    expect(aws.sends).toHaveLength(before);
  });
});
