import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { providers } from "@/lib/db/schema";
import { encryptCredentials, adapterFor, type ProviderRow } from "@/lib/providers";
import { API_RATE, acquireSendPermits, apiRateSubject, setSendRate } from "@/lib/providers/send-rate";
import { listProviderHealth, recordProviderProbe } from "@/lib/health/checks";
import { closeRedis } from "@/lib/redis";
import { API_RETRY } from "@/lib/providers/adapters/ses";
import type { OutboundMessage } from "@/lib/providers/adapters/types";
import { awsError, resetDatabase, seedFixture } from "./fixtures";
import { clearRedisKeys, testRedisUrl } from "../redis";

const REDIS_URL = testRedisUrl();
const IDENTITY = "111122223333";
const OTHER_IDENTITY = "444455556666";

const { aws, cloudWatchCalls } = vi.hoisted(() => ({
  aws: {
    calls: [] as { name: string; at: number; key: string }[],
    reply: (_name: string): unknown => ({}),
  },
  cloudWatchCalls: [] as number[],
}));

vi.mock("@aws-sdk/client-sesv2", () => {
  class FakeCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  const names = [
    "SendEmailCommand",
    "GetAccountCommand",
    "GetTenantCommand",
    "GetEmailIdentityCommand",
    "CreateEmailIdentityCommand",
    "PutEmailIdentityMailFromAttributesCommand",
    "ListRecommendationsCommand",
  ];
  return {
    SESv2Client: class {
      constructor(private readonly config: { credentials: { accessKeyId: string } }) {}
      async send(command: FakeCommand) {
        const name = command.constructor.name;
        aws.calls.push({ name, at: Date.now(), key: this.config.credentials.accessKeyId });
        return aws.reply(name);
      }
    },
    ...Object.fromEntries(names.map((name) => [name, { [name]: class extends FakeCommand {} }[name]])),
  };
});

vi.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: class {
    async send() {
      cloudWatchCalls.push(Date.now());
      return { MetricDataResults: [] };
    }
  },
  GetMetricDataCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

function defaultReply(name: string): unknown {
  switch (name) {
    case "GetAccountCommand":
      return { SendingEnabled: true, SendQuota: { MaxSendRate: 14 } };
    case "GetTenantCommand":
      return { Tenant: { SendingStatus: "ENABLED" } };
    case "GetEmailIdentityCommand":
      return { DkimAttributes: { Status: "SUCCESS" }, VerifiedForSendingStatus: true, MailFromAttributes: { MailFromDomainStatus: "SUCCESS" } };
    case "CreateEmailIdentityCommand":
      return { DkimAttributes: { Tokens: ["t1"] } };
    case "SendEmailCommand":
      return { MessageId: "m-1" };
    default:
      return {};
  }
}

function row(overrides: Partial<ProviderRow> & { accessKeyId?: string }): ProviderRow {
  const { accessKeyId = "AKIA-ONE", ...rest } = overrides;
  return {
    id: `pa_${Math.random().toString(36).slice(2)}`,
    organizationId: "org_1",
    adapter: "ses",
    name: "SES",
    credentials: encryptCredentials({ accessKeyId, secretAccessKey: "secret", region: "us-west-2" }),
    settings: {},
    providerIdentity: IDENTITY,
    shared: false,
    sharedProviderId: null,
    ...rest,
  } as ProviderRow;
}

const outbound: OutboundMessage = {
  id: "msg_1",
  from: { name: null, address: "ada@example.com" },
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
};

function controlCalls(): { name: string; at: number; key: string }[] {
  return aws.calls.filter((call) => call.name !== "SendEmailCommand").sort((a, b) => a.at - b.at);
}

/** SES's real rate is one a second; the suite runs faster at the same shape. */
const PER_SECOND = 20;
const INTERVAL_MS = 1000 / PER_SECOND;

/** Fails when any window of one interval holds more than one call. */
function expectPaced(times: number[]): void {
  const sorted = [...times].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(INTERVAL_MS);
}

const retryDefaults = { ...API_RETRY };
const rateDefaults = { ...API_RATE };

beforeEach(async () => {
  await resetDatabase();
  API_RATE.perSecond = PER_SECOND;
  process.env.REDIS_URL = REDIS_URL;
  aws.calls.length = 0;
  aws.reply = defaultReply;
  cloudWatchCalls.length = 0;
});
afterEach(async () => {
  Object.assign(API_RETRY, retryDefaults);
  Object.assign(API_RATE, rateDefaults);
  await clearRedisKeys("api-rate:", "send-rate:", "health:provider:");
  delete process.env.REDIS_URL;
  await closeRedis();
});

describe("SES non-send pacing", () => {
  it("keeps every non-send call on one AWS account to the rate, across rows and callers", async () => {
    const shared = row({ shared: true, settings: { sharing: "operator" } });
    const tenant = row({ sharedProviderId: shared.id, settings: { tenantName: "tenant-a" }, accessKeyId: "AKIA-TENANT" });
    const ordinary = row({ accessKeyId: "AKIA-OWN" });

    await Promise.all([
      adapterFor(ordinary).healthCheck(),
      adapterFor(ordinary).quota!(),
      adapterFor(ordinary).domain.verify("example.com", "example.com"),
      adapterFor(ordinary).domain.create("example.org"),
      adapterFor(shared).tenants!.status("tenant-a"),
      adapterFor(tenant).healthCheck(),
    ]);

    const calls = controlCalls();
    expect(calls).toHaveLength(7);
    expectPaced(calls.map((call) => call.at));
  });

  it("paces each AWS account on its own", async () => {
    const one = row({});
    const other = row({ providerIdentity: OTHER_IDENTITY, accessKeyId: "AKIA-OTHER" });

    await Promise.all([adapterFor(one).quota!(), adapterFor(one).quota!(), adapterFor(other).quota!(), adapterFor(other).quota!()]);

    const calls = controlCalls();
    const byKey = (key: string) => calls.filter((call) => call.key === key).map((call) => call.at);
    expectPaced(byKey("AKIA-ONE"));
    expectPaced(byKey("AKIA-OTHER"));
    expect(Math.max(...calls.map((call) => call.at)) - Math.min(...calls.map((call) => call.at))).toBeLessThan(2 * INTERVAL_MS);
  });

  it("paces a row with no known identity by its access key", async () => {
    const first = row({ providerIdentity: null });
    const second = row({ providerIdentity: null });

    await Promise.all([adapterFor(first).quota!(), adapterFor(second).quota!()]);

    expectPaced(controlCalls().map((call) => call.at));
  });

  it("leaves sends, send permits and CloudWatch reads out of the non-send budget", async () => {
    // At one a second, any paced call here would blow the 500 ms budget below.
    API_RATE.perSecond = 1;
    const providerRow = row({});
    const provider = adapterFor(providerRow);
    await provider.quota!();
    await setSendRate(apiRateSubject(providerRow)!, 14);
    const started = Date.now();

    const receipts = await Promise.all([provider.send(outbound), provider.send(outbound), provider.send(outbound)]);
    await provider.reputationRates!();
    await provider.reputationRates!();

    expect(receipts.every((receipt) => receipt.successful)).toBe(true);
    expect(cloudWatchCalls).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(500);
    expect((await acquireSendPermits(apiRateSubject(providerRow)!, 1)).granted).toBe(1);
  });

  it("retries a throttled non-send call with backoff, and answers", async () => {
    let throttles = 1;
    aws.reply = (name) => {
      if (name === "GetAccountCommand" && throttles-- > 0) throw awsError("TooManyRequestsException", 429);
      return defaultReply(name);
    };

    expect(await adapterFor(row({})).healthCheck()).toEqual({ ok: true, detail: null });

    const calls = controlCalls();
    expect(calls).toHaveLength(2);
    expectPaced(calls.map((call) => call.at));
  });

  it("doesn't retry a non-send error that isn't a throttle or an outage", async () => {
    aws.reply = () => {
      throw awsError("NotFoundException", 404);
    };

    expect(await adapterFor(row({})).domain.verify("example.com", "example.com")).toMatchObject({ answered: false });
    expect(controlCalls()).toHaveLength(1);
  });

  it("doesn't report a probe that stays throttled as a health failure", async () => {
    API_RETRY.attempts = 2;
    API_RETRY.baseMs = 10;
    const fixture = await seedFixture({ providerAdapter: "ses", credentials: { accessKeyId: "AKIA-ONE", secretAccessKey: "s", region: "us-west-2" } });
    await db.update(providers).set({ providerIdentity: IDENTITY }).where(eq(providers.id, fixture.providerId));
    const [provider] = await db.select().from(providers).where(eq(providers.id, fixture.providerId));
    await recordProviderProbe(provider!.id, "ses", { ok: true, detail: null });
    aws.reply = () => {
      throw awsError("TooManyRequestsException", 429);
    };

    const health = await adapterFor(provider!).healthCheck();
    await recordProviderProbe(provider!.id, "ses", health);

    expect(health.ok).not.toBe(false);
    expect(controlCalls()).toHaveLength(2);
    const [view] = (await listProviderHealth()).filter((entry) => entry.providerId === provider!.id);
    expect(view).toMatchObject({ ok: true, detail: null });
  });
});
