import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys, batches, domains, lists, organizations, providers } from "@/lib/db/schema";
import { generateKeySecret } from "@/lib/api/keys";
import { newId } from "@/lib/ids";
import type { ProposedDnsRecord } from "@/lib/providers/adapters/types";
import { GET as list, POST as create } from "@/app/api/v1/domains/route";
import { DELETE as remove, GET as read, PATCH as patch } from "@/app/api/v1/domains/[id]/route";
import { POST as verify } from "@/app/api/v1/domains/[id]/verify/route";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { resetMockSends } from "@/lib/providers/adapters/mock";
import { mergeSettings } from "@/lib/providers";
import { addDomainKeyFor, addProvider, apiRequest, resetDatabase, routeContext, seedFixture, type Fixture } from "./fixtures";

const { FakeCommand, sesSend, snsSend } = vi.hoisted(() => {
  class FakeCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  const sesSend = vi.fn();
  const snsSend = vi.fn();
  return { FakeCommand, sesSend, snsSend };
});

vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: class {
    constructor(public readonly config: Record<string, unknown>) {}
    send(command: InstanceType<typeof FakeCommand>) {
      return sesSend(command);
    }
  },
  SendEmailCommand: class extends FakeCommand {},
  CreateEmailIdentityCommand: class extends FakeCommand {},
  GetEmailIdentityCommand: class extends FakeCommand {},
  DeleteEmailIdentityCommand: class extends FakeCommand {},
  PutEmailIdentityMailFromAttributesCommand: class extends FakeCommand {},
  CreateConfigurationSetCommand: class extends FakeCommand {},
  CreateConfigurationSetEventDestinationCommand: class extends FakeCommand {},
}));

// Every registered adapter happens to support domainsViaApi and verifyViaApi today — a target
// provider can only fail this gate through an adapter that doesn't, which the registry doesn't
// currently ship. This fakes one, to exercise the gate itself rather than assume it's dead code.
vi.mock("@/lib/providers/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/adapters")>();
  return {
    ...actual,
    capabilitiesOf: (adapter: string) =>
      adapter === "no_domains_api" ? { ...actual.capabilitiesOf("mock"), domainsViaApi: false } : actual.capabilitiesOf(adapter),
  };
});

vi.mock("@aws-sdk/client-sns", () => ({
  SNSClient: class {
    constructor(public readonly config: Record<string, unknown>) {}
    send(command: InstanceType<typeof FakeCommand>) {
      return snsSend(command);
    }
  },
  CreateTopicCommand: class extends FakeCommand {},
  SubscribeCommand: class extends FakeCommand {},
  ConfirmSubscriptionCommand: class extends FakeCommand {},
  SetTopicAttributesCommand: class extends FakeCommand {},
}));

interface SerializedDomain {
  id: string;
  name: string;
  status: string;
  verified_at: string | null;
  dns_records: { type: string; name: string; value: string; merge?: string }[];
  missing_records: { type: string; name: string }[];
  setup: { step: string; message: string }[];
  errors: string[];
  pending: {
    provider_id: string;
    dns_records: { type: string; name: string; value: string }[];
    missing_records: { type: string; name: string }[];
    started_at: string;
  } | null;
}

interface ErrorBody {
  error: { code: string; message: string; field?: string; detail?: Record<string, unknown> };
}

const request = (secret: string, path: string, method = "GET", body?: unknown): Request =>
  apiRequest(secret, `/v1/domains${path}`, method, body);

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  resetMockSends();
  fixture = await seedFixture({ scopeToDomain: false });
});
afterEach(() => vi.unstubAllGlobals());

/** A second key on the same organization with no domain scope, which is what may create domains. */
async function grantAll(of: Fixture): Promise<string> {
  const generated = generateKeySecret("live");
  await db.insert(apiKeys).values({
    id: newId("key"),
    organizationId: of.organizationId,
    name: "unscoped",
    secretHash: generated.secretHash,
    secretPrefix: generated.secretPrefix,
    mode: generated.mode,
    domainIds: [],
  });
  return generated.secret;
}

async function createDomain(name = "example.net"): Promise<Response> {
  return create(request(fixture.secret, "", "POST", { name, provider_id: fixture.providerId }));
}

describe("POST /v1/domains", () => {
  it("binds to the organization's assigned provider when the request names none", async () => {
    const other = await addProvider(fixture, { providerAdapter: "mock" });
    await db.update(organizations).set({ providerId: other.providerId }).where(eq(organizations.id, fixture.organizationId));

    const response = await create(request(fixture.secret, "", "POST", { name: "assigned.example.net" }));

    expect(response.status).toBe(201);
    const [row] = await db.select().from(domains).where(eq(domains.name, "assigned.example.net"));
    expect(row?.providerId).toBe(other.providerId);
  });

  it("refuses a domain with no provider named and none assigned", async () => {
    const response = await create(request(fixture.secret, "", "POST", { name: "unassigned.example.net" }));
    const body = (await response.json()) as { error: { code: string; field?: string } };

    expect(response.status).toBe(422);
    expect(body.error).toMatchObject({ code: "provider_unassigned", field: "provider_id" });
    expect(await db.select().from(domains).where(eq(domains.name, "unassigned.example.net"))).toEqual([]);
  });

  it("creates a pending domain with the records the provider asked for", async () => {
    const response = await createDomain();
    const body = (await response.json()) as SerializedDomain;

    expect(response.status).toBe(201);
    expect(body.id).toMatch(/^dom_/);
    expect(body.name).toBe("example.net");
    expect(body.status).toBe("pending");
    expect(body.verified_at).toBeNull();
    expect(body.dns_records.length).toBeGreaterThan(0);
    expect(body.dns_records[0]).toHaveProperty("value");
    // The provider can't see the recommended DMARC record, so it never lists it as missing.
    expect(body.dns_records.find((record) => record.name === "_dmarc.example.net")).toMatchObject({ type: "TXT", value: "v=DMARC1; p=none;" });
    expect(body.missing_records.length).toBe(body.dns_records.length - 1);
    expect(body.missing_records.some((record) => record.name.startsWith("_dmarc."))).toBe(false);
    expect(body.setup).toEqual([]);

    const [row] = await db.select().from(domains).where(eq(domains.id, body.id)).limit(1);
    expect(row?.providerDomainId).toBe("mock_example.net");
    const [provider] = await db
      .select()
      .from(providers)
      .where(eq(providers.id, fixture.providerId))
      .limit(1);
    expect(provider?.settings.mockConfigured).toBe("true");
  });

  it("leaves the webhook step to an admin and marks the SPF record to merge, for a provider that registers webhooks by hand", async () => {
    const mailpace = await seedFixture({
      providerAdapter: "mailpace",
      scopeToDomain: false,
      credentials: { serverToken: "test-token", organizationToken: "org-token" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: 12,
          name: "example.net",
          dkim_host: "mailpace._domainkey.example.net",
          dkim_value: "v=DKIM1; k=rsa; p=recorded",
          return_path_domain: "bounces.example.net",
          return_path_value: "relay.mailpace.com",
          spf_value: "v=spf1 include:relay.mailpace.com ~all",
          dkim_verified: false,
        }),
      ),
    );

    const response = await create(
      request(mailpace.secret, "", "POST", { name: "example.net", provider_id: mailpace.providerId }),
    );
    const body = (await response.json()) as SerializedDomain;

    expect(response.status).toBe(201);
    expect(body.dns_records.map((record) => record.type)).toContain("CNAME");
    // Registering it is in the provider's console, which only an admin reaches.
    expect(body.setup.find((step) => step.step === "webhooks")?.message).toBe("Event delivery: waiting on an admin.");
    expect(body.dns_records.find((record) => record.name === "example.net")?.merge).toBe("spf");
    expect(body.dns_records.filter((record) => record.merge !== undefined)).toHaveLength(1);
  });

  it("names the unfinished step when the provider setup failed, rather than reporting nothing to do", async () => {
    const response = await createDomain("fail.example");
    const body = (await response.json()) as SerializedDomain;

    expect(response.status).toBe(201);
    expect(body.setup.map((step) => step.step)).toEqual(["webhooks"]);
    expect(body.setup[0]?.message).toMatch(/verify/i);
  });

  it("retries the provider setup on the next verify", async () => {
    const created = (await (await createDomain("fail.example")).json()) as SerializedDomain;

    const body = (await (
      await verify(request(fixture.secret, `/${created.id}/verify`, "POST"), routeContext(created.id))
    ).json()) as SerializedDomain;

    expect(body.setup).toEqual([]);
    const [provider] = await db
      .select()
      .from(providers)
      .where(eq(providers.id, fixture.providerId))
      .limit(1);
    expect(provider?.settings.mockConfigured).toBe("true");
  });

  it("refuses a domain the organization already has", async () => {
    await createDomain();

    expect((await createDomain()).status).toBe(422);
  });

  it("refuses a provider the key's organization doesn't own", async () => {
    const other = await seedFixture();

    const response = await create(
      request(fixture.secret, "", "POST", { name: "example.net", provider_id: other.providerId }),
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  it("refuses a domain-scoped key, which couldn't read the domain it just made", async () => {
    const scoped = await seedFixture();

    const response = await create(
      request(scoped.secret, "", "POST", { name: "example.net", provider_id: scoped.providerId }),
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("key_not_scoped");
    expect(await db.select().from(domains).where(eq(domains.name, "example.net"))).toHaveLength(0);
  });

  it("rejects a name that isn't a domain", async () => {
    const response = await create(
      request(fixture.secret, "", "POST", { name: "not a domain", provider_id: fixture.providerId }),
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.field).toBe("name");
  });

  it("says a missing field is required, the way POST /v1/emails does", async () => {
    const response = await create(request(fixture.secret, "", "POST", { provider_id: fixture.providerId }));
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(422);
    expect(body.error.field).toBe("name");
    expect(body.error.message).toBe('Field "name" is required.');
  });

  it("stores the name lowercased, so a send from any casing matches it", async () => {
    const response = await create(
      request(fixture.secret, "", "POST", { name: "Example.NET", provider_id: fixture.providerId }),
    );
    const body = (await response.json()) as SerializedDomain;

    expect(body.name).toBe("example.net");
  });
});

describe("POST /v1/domains on an SES account", () => {
  const SES_CREDENTIALS = { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", region: "us-west-2" };
  const TOPIC_ARN = "arn:aws:sns:us-west-2:123456789012:mail-events-example-net";

  function named(command: InstanceType<typeof FakeCommand>): string {
    return command.constructor.name;
  }

  beforeEach(() => {
    sesSend.mockReset();
    snsSend.mockReset();
    sesSend.mockImplementation(async (command: InstanceType<typeof FakeCommand>) => {
      if (named(command) === "CreateEmailIdentityCommand") {
        return { DkimAttributes: { Tokens: ["t1", "t2", "t3"] } };
      }
      return {};
    });
    snsSend.mockImplementation(async (command: InstanceType<typeof FakeCommand>) => {
      if (named(command) === "CreateTopicCommand") return { TopicArn: TOPIC_ARN };
      return {};
    });
  });

  it("lists the webhook step before subscription confirmation, then clears it once it's confirmed", async () => {
    const ses = await seedFixture({
      providerAdapter: "ses",
      scopeToDomain: false,
      credentials: SES_CREDENTIALS,
      settings: {},
    });

    const response = await create(
      request(ses.secret, "", "POST", { name: "example.net", provider_id: ses.providerId }),
    );
    const created = (await response.json()) as SerializedDomain;

    expect(response.status).toBe(201);
    const webhook = created.setup.find((step) => step.step === "webhooks");
    expect(webhook).toBeDefined();
    expect(webhook?.message.toLowerCase()).toMatch(/event delivery|subscription/);

    await mergeSettings(ses.providerId, { subscriptionConfirmed: "true" });

    const verifyResponse = await verify(
      request(ses.secret, `/${created.id}/verify`, "POST"),
      routeContext(created.id),
    );
    const verified = (await verifyResponse.json()) as SerializedDomain;

    expect(verifyResponse.status).toBe(200);
    expect(verified.setup).toEqual([]);
  });
});

describe("GET /v1/domains", () => {
  it("lists the organization's domains, newest first", async () => {
    await createDomain();

    const response = await list(request(fixture.secret, ""));
    const body = (await response.json()) as { data: SerializedDomain[]; next_cursor: string | null };

    expect(response.status).toBe(200);
    expect(body.data.map((domain) => domain.name)).toEqual(["example.net", "example.com"]);
    expect(body.next_cursor).toBeNull();
  });

  it("shows a scoped key only the domains it can send from", async () => {
    const scoped = await seedFixture();
    const unscoped = await grantAll(scoped);
    await create(request(unscoped, "", "POST", { name: "example.net", provider_id: scoped.providerId }));

    const body = (await (await list(request(scoped.secret, ""))).json()) as { data: SerializedDomain[] };

    expect(body.data.map((domain) => domain.name)).toEqual(["example.com"]);
  });

  it("ignores a cursor that names another organization's domain", async () => {
    // Created between the caller's two domains, so a leaked anchor would hide one of them.
    const other = await seedFixture();
    await createDomain("one.example");

    const body = (await (await list(request(fixture.secret, `?cursor=${other.domainId}`))).json()) as {
      data: SerializedDomain[];
    };

    expect(body.data.map((domain) => domain.name).sort()).toEqual(["example.com", "one.example"]);
  });

  it("pages with a cursor", async () => {
    await createDomain("one.example");
    await createDomain("two.example");

    const first = (await (await list(request(fixture.secret, "?limit=1"))).json()) as {
      data: SerializedDomain[];
      next_cursor: string | null;
    };
    expect(first.data).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();

    const second = (await (await list(request(fixture.secret, `?limit=1&cursor=${first.next_cursor}`))).json()) as {
      data: SerializedDomain[];
    };
    expect(second.data[0]?.name).not.toBe(first.data[0]?.name);
  });

  it("filters by status", async () => {
    await createDomain("one.example");

    const body = (await (await list(request(fixture.secret, "?status=verified"))).json()) as {
      data: SerializedDomain[];
    };

    expect(body.data.map((domain) => domain.name)).toEqual(["example.com"]);
  });

  it("rejects a status that isn't a lifecycle value", async () => {
    const response = await list(request(fixture.secret, "?status=deleted"));
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.field).toBe("status");
  });
});

describe("GET /v1/domains/:id", () => {
  it("returns one domain", async () => {
    const created = (await (await createDomain()).json()) as SerializedDomain;

    const response = await read(request(fixture.secret, `/${created.id}`), routeContext(created.id));
    const body = (await response.json()) as SerializedDomain;

    expect(response.status).toBe(200);
    expect(body.name).toBe("example.net");
  });

  it("reports missing records from the stored column, not just a live verify", async () => {
    const created = (await (await createDomain()).json()) as SerializedDomain;
    const outstanding = created.dns_records.slice(0, 1) as unknown as ProposedDnsRecord[];
    await db.update(domains).set({ missingRecords: outstanding }).where(eq(domains.id, created.id));

    const response = await read(request(fixture.secret, `/${created.id}`), routeContext(created.id));
    const body = (await response.json()) as SerializedDomain;

    expect(response.status).toBe(200);
    expect(body.missing_records.length).toBe(outstanding.length);
  });

  it("returns 404 for an id in another organization", async () => {
    const other = await seedFixture();

    const response = await read(request(fixture.secret, `/${other.domainId}`), routeContext(other.domainId));
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  it("returns 403 for a domain outside the key's scope", async () => {
    const scoped = await seedFixture();
    const unscoped = await grantAll(scoped);
    const created = (await (
      await create(request(unscoped, "", "POST", { name: "example.net", provider_id: scoped.providerId }))
    ).json()) as SerializedDomain;

    const response = await read(request(scoped.secret, `/${created.id}`), routeContext(created.id));
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("key_not_scoped");
  });
});

describe("POST /v1/domains/:id/verify", () => {
  it("flips a pending domain to verified and records when it was checked", async () => {
    const created = (await (await createDomain()).json()) as SerializedDomain;

    const response = await verify(request(fixture.secret, `/${created.id}/verify`, "POST"), routeContext(created.id));
    const body = (await response.json()) as SerializedDomain;

    expect(response.status).toBe(200);
    expect(body.status).toBe("verified");
    expect(body.verified_at).not.toBeNull();
    expect(body.missing_records).toEqual([]);

    const [row] = await db.select().from(domains).where(eq(domains.id, created.id)).limit(1);
    expect(row?.lastCheckedAt).not.toBeNull();
  });

  it("leaves a verified domain verified when the provider can't be reached", async () => {
    const mailpace = await seedFixture({
      providerAdapter: "mailpace",
      scopeToDomain: false,
      credentials: { serverToken: "t", organizationToken: "org-token" },
    });
    await db.update(domains).set({ providerDomainId: "12" }).where(eq(domains.id, mailpace.domainId));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gateway timeout", { status: 504 })));

    const response = await verify(
      request(mailpace.secret, `/${mailpace.domainId}/verify`, "POST"),
      routeContext(mailpace.domainId),
    );
    const body = (await response.json()) as SerializedDomain;

    expect(response.status).toBe(200);
    expect(body.status).toBe("verified");
    expect(body.verified_at).not.toBeNull();

    const row = await db.select().from(domains).where(eq(domains.id, mailpace.domainId)).limit(1);
    expect(row[0]?.status).toBe("verified");
    expect(row[0]?.verifiedAt).not.toBeNull();
    expect(row[0]?.lastCheckedAt).not.toBeNull();
  });

  it("demotes a domain the provider says isn't verified any more", async () => {
    const mailpace = await seedFixture({
      providerAdapter: "mailpace",
      scopeToDomain: false,
      credentials: { serverToken: "t", organizationToken: "org-token" },
    });
    await db.update(domains).set({ providerDomainId: "12" }).where(eq(domains.id, mailpace.domainId));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: 12,
          dkim_verified: false,
          dkim_host: "mailpace._domainkey.example.com",
          dkim_value: "v=DKIM1; k=rsa; p=recorded",
          errors: {},
        }),
      ),
    );

    const body = (await (
      await verify(request(mailpace.secret, `/${mailpace.domainId}/verify`, "POST"), routeContext(mailpace.domainId))
    ).json()) as SerializedDomain;

    expect(body.status).toBe("pending");
    expect(body.verified_at).toBeNull();
    expect(body.missing_records.length).toBeGreaterThan(0);
  });

  it("fails a domain when the provider reports a terminal error, storing the reasons", async () => {
    const mailpace = await seedFixture({
      providerAdapter: "mailpace",
      scopeToDomain: false,
      credentials: { serverToken: "t", organizationToken: "org-token" },
    });
    await db.update(domains).set({ providerDomainId: "12" }).where(eq(domains.id, mailpace.domainId));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: 12,
          dkim_verified: false,
          dkim_host: "mailpace._domainkey.example.com",
          dkim_value: "v=DKIM1; k=rsa; p=recorded",
          errors: { dkim: "DKIM verification is FAILED. Recreate the domain." },
        }),
      ),
    );

    const body = (await (
      await verify(request(mailpace.secret, `/${mailpace.domainId}/verify`, "POST"), routeContext(mailpace.domainId))
    ).json()) as SerializedDomain;

    expect(body.status).toBe("failed");
    expect(body.verified_at).toBeNull();
    expect(body.errors).toEqual(["DKIM verification is FAILED. Recreate the domain."]);

    const [row] = await db.select().from(domains).where(eq(domains.id, mailpace.domainId)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.verificationErrors).toEqual(["DKIM verification is FAILED. Recreate the domain."]);
  });

  it("recovers a failed domain to verified once the provider verifies it, clearing the stored reasons", async () => {
    const mailpace = await seedFixture({
      providerAdapter: "mailpace",
      scopeToDomain: false,
      credentials: { serverToken: "t", organizationToken: "org-token" },
    });
    await db
      .update(domains)
      .set({ providerDomainId: "12", status: "failed", verificationErrors: ["DKIM verification is FAILED. Recreate the domain."] })
      .where(eq(domains.id, mailpace.domainId));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ id: 12, dkim_verified: true, errors: {} })),
    );

    const body = (await (
      await verify(request(mailpace.secret, `/${mailpace.domainId}/verify`, "POST"), routeContext(mailpace.domainId))
    ).json()) as SerializedDomain;

    expect(body.status).toBe("verified");
    expect(body.verified_at).not.toBeNull();
    expect(body.errors).toEqual([]);

    const [row] = await db.select().from(domains).where(eq(domains.id, mailpace.domainId)).limit(1);
    expect(row?.status).toBe("verified");
    expect(row?.verificationErrors).toEqual([]);
  });

  it("returns 404 for a domain the key's organization doesn't have", async () => {
    const response = await verify(request(fixture.secret, "/dom_nothere/verify", "POST"), routeContext("dom_nothere"));

    expect(response.status).toBe(404);
  });
});

describe("POST /v1/domains/:id/verify on an SES account", () => {
  const SES_CREDENTIALS = { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", region: "us-west-2" };
  const SES_SETTINGS = {
    configurationSetName: "mail-events-example-com",
    topicArn: "arn:aws:sns:us-west-2:123456789012:mail-events-example-com",
    subscriptionConfirmed: "true",
  };

  /** A verified SES domain and the identity SES reports for it. */
  async function verifiedDomain(identity: Record<string, unknown>): Promise<Fixture> {
    sesSend.mockReset();
    snsSend.mockReset();
    sesSend.mockResolvedValue(identity);
    const ses = await seedFixture({
      providerAdapter: "ses",
      scopeToDomain: false,
      credentials: SES_CREDENTIALS,
      settings: SES_SETTINGS,
    });
    await db.update(domains).set({ providerDomainId: "example.com" }).where(eq(domains.id, ses.domainId));
    return ses;
  }

  async function verifyDomain(ses: Fixture): Promise<SerializedDomain> {
    const response = await verify(request(ses.secret, `/${ses.domainId}/verify`, "POST"), routeContext(ses.domainId));
    return (await response.json()) as SerializedDomain;
  }

  it("keeps a verified domain verified when SES can't determine its DKIM status", async () => {
    const ses = await verifiedDomain({
      VerifiedForSendingStatus: false,
      DkimAttributes: { Status: "TEMPORARY_FAILURE", Tokens: ["t1", "t2", "t3"] },
      MailFromAttributes: { MailFromDomain: "mail.example.com", MailFromDomainStatus: "SUCCESS" },
    });

    const body = await verifyDomain(ses);

    expect(body.status).toBe("verified");
    expect(body.verified_at).not.toBeNull();

    const [row] = await db.select().from(domains).where(eq(domains.id, ses.domainId)).limit(1);
    expect(row?.status).toBe("verified");
    expect(row?.verifiedAt).not.toBeNull();
  });

  it("keeps a verified domain verified when SES holds it back despite SUCCESS DKIM", async () => {
    const ses = await verifiedDomain({
      VerifiedForSendingStatus: false,
      DkimAttributes: { Status: "SUCCESS", Tokens: ["t1", "t2", "t3"] },
      MailFromAttributes: { MailFromDomain: "mail.example.com", MailFromDomainStatus: "SUCCESS" },
    });

    const body = await verifyDomain(ses);

    expect(body.status).toBe("verified");
    expect(body.verified_at).not.toBeNull();

    const [row] = await db.select().from(domains).where(eq(domains.id, ses.domainId)).limit(1);
    expect(row?.status).toBe("verified");
    expect(row?.verifiedAt).not.toBeNull();
  });

  it("demotes a domain SES answers about with its DKIM records still missing", async () => {
    const ses = await verifiedDomain({
      VerifiedForSendingStatus: false,
      DkimAttributes: { Status: "PENDING", Tokens: ["t1", "t2", "t3"] },
      MailFromAttributes: { MailFromDomain: "mail.example.com", MailFromDomainStatus: "PENDING" },
    });

    const body = await verifyDomain(ses);

    expect(body.status).toBe("pending");
    expect(body.verified_at).toBeNull();
    expect(body.missing_records.length).toBeGreaterThan(0);
  });
});

describe("PATCH /v1/domains/:id", () => {
  it("records a pending binding without moving the domain", async () => {
    const target = await addProvider(fixture, { providerAdapter: "mock", name: "secondary" });

    const response = await patch(
      request(fixture.secret, `/${fixture.domainId}`, "PATCH", { provider_id: target.providerId }),
      routeContext(fixture.domainId),
    );
    const body = (await response.json()) as SerializedDomain;

    expect(response.status).toBe(200);
    expect(body.status).toBe("verified");
    expect(body.pending?.provider_id).toBe(target.providerId);
    expect(body.pending?.dns_records.length).toBeGreaterThan(0);
    expect(body.pending?.missing_records.length).toBe(body.pending?.dns_records.length);
    expect(body.pending?.started_at).toBeDefined();

    const [row] = await db.select().from(domains).where(eq(domains.id, fixture.domainId)).limit(1);
    expect(row?.providerId).toBe(fixture.providerId);
    expect(row?.pendingProviderId).toBe(target.providerId);
  });

  it("is idempotent when the same target is already pending", async () => {
    const target = await addProvider(fixture, { providerAdapter: "mock", name: "secondary" });
    await patch(
      request(fixture.secret, `/${fixture.domainId}`, "PATCH", { provider_id: target.providerId }),
      routeContext(fixture.domainId),
    );

    const response = await patch(
      request(fixture.secret, `/${fixture.domainId}`, "PATCH", { provider_id: target.providerId }),
      routeContext(fixture.domainId),
    );

    expect(response.status).toBe(200);
    const [row] = await db.select().from(domains).where(eq(domains.id, fixture.domainId)).limit(1);
    expect(row?.pendingProviderId).toBe(target.providerId);
  });

  it("cancels a pending move at no cost, restoring the prior state", async () => {
    const target = await addProvider(fixture, { providerAdapter: "mock", name: "secondary" });
    await patch(
      request(fixture.secret, `/${fixture.domainId}`, "PATCH", { provider_id: target.providerId }),
      routeContext(fixture.domainId),
    );

    const response = await patch(
      request(fixture.secret, `/${fixture.domainId}`, "PATCH", { provider_id: null }),
      routeContext(fixture.domainId),
    );
    const body = (await response.json()) as SerializedDomain;

    expect(response.status).toBe(200);
    expect(body.pending).toBeNull();
    expect(body.status).toBe("verified");

    const [row] = await db.select().from(domains).where(eq(domains.id, fixture.domainId)).limit(1);
    expect(row?.providerId).toBe(fixture.providerId);
    expect(row?.pendingProviderId).toBeNull();
    expect(row?.pendingDnsRecords).toEqual([]);
  });

  it("cancelling with no move in progress is a no-op", async () => {
    const response = await patch(
      request(fixture.secret, `/${fixture.domainId}`, "PATCH", { provider_id: null }),
      routeContext(fixture.domainId),
    );
    const body = (await response.json()) as SerializedDomain;

    expect(response.status).toBe(200);
    expect(body.pending).toBeNull();
  });

  it("refuses a target the domain is already bound to", async () => {
    const response = await patch(
      request(fixture.secret, `/${fixture.domainId}`, "PATCH", { provider_id: fixture.providerId }),
      routeContext(fixture.domainId),
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.field).toBe("provider_id");
  });

  it("refuses a target provider that can't create a domain through its API", async () => {
    const incapable = await addProvider(fixture, { providerAdapter: "no_domains_api", name: "secondary" });

    const response = await patch(
      request(fixture.secret, `/${fixture.domainId}`, "PATCH", { provider_id: incapable.providerId }),
      routeContext(fixture.domainId),
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("capability_unavailable");

    const [row] = await db.select().from(domains).where(eq(domains.id, fixture.domainId)).limit(1);
    expect(row?.pendingProviderId).toBeNull();
  });

  it("refuses a provider the key's organization doesn't own", async () => {
    const other = await seedFixture();

    const response = await patch(
      request(fixture.secret, `/${fixture.domainId}`, "PATCH", { provider_id: other.providerId }),
      routeContext(fixture.domainId),
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  it("refuses a domain-scoped key that isn't scoped to this domain", async () => {
    const other = await addDomainKeyFor(fixture, fixture.providerId, "other.example");
    const target = await addProvider(fixture, { providerAdapter: "mock", name: "secondary" });

    const response = await patch(
      request(other.secret, `/${fixture.domainId}`, "PATCH", { provider_id: target.providerId }),
      routeContext(fixture.domainId),
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("key_not_scoped");
  });

  it("refuses a domain in another organization entirely", async () => {
    const other = await seedFixture();
    const target = await addProvider(other, { providerAdapter: "mock", name: "secondary" });

    const response = await patch(
      request(other.secret, `/${fixture.domainId}`, "PATCH", { provider_id: target.providerId }),
      routeContext(fixture.domainId),
    );

    expect(response.status).toBe(404);
  });

  it("lets a key scoped to the domain move it", async () => {
    const scoped = await seedFixture({ scopeToDomain: true });
    const scopedTarget = await addProvider(scoped, { providerAdapter: "mock", name: "secondary" });

    const response = await patch(
      request(scoped.secret, `/${scoped.domainId}`, "PATCH", { provider_id: scopedTarget.providerId }),
      routeContext(scoped.domainId),
    );

    expect(response.status).toBe(200);
  });
});

describe("DELETE /v1/domains/:id", () => {
  it("removes a domain nothing has sent from", async () => {
    const created = (await (await createDomain()).json()) as SerializedDomain;

    const response = await remove(request(fixture.secret, `/${created.id}`, "DELETE"), routeContext(created.id));

    expect(response.status).toBe(200);
    expect(await db.select().from(domains).where(eq(domains.id, created.id))).toHaveLength(0);
  });

  it("drops a mailpace-bound domain locally, since the provider has no delete endpoint to call", async () => {
    const { providerId } = await addProvider(fixture, {
      providerAdapter: "mailpace",
      credentials: { serverToken: "test-token" },
    });
    const { domainId } = await addDomainKeyFor(fixture, providerId, "leftover.example.net");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await remove(request(fixture.secret, `/${domainId}`, "DELETE"), routeContext(domainId));

    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.select().from(domains).where(eq(domains.id, domainId))).toHaveLength(0);
  });

  it("keeps the row and surfaces the error when the provider delete fails", async () => {
    const { providerId } = await addProvider(fixture, {
      providerAdapter: "ses",
      credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", region: "us-west-2" },
    });
    const { domainId } = await addDomainKeyFor(fixture, providerId, "stuck.example.net");
    sesSend.mockReset();
    sesSend.mockImplementation(async (command: InstanceType<typeof FakeCommand>) => {
      if (command.constructor.name === "DeleteEmailIdentityCommand") {
        throw Object.assign(new Error("Rate exceeded."), { name: "TooManyRequestsException" });
      }
      return {};
    });

    const response = await remove(request(fixture.secret, `/${domainId}`, "DELETE"), routeContext(domainId));
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("provider_unavailable");
    expect(body.error.message).toContain("Rate exceeded.");
    expect(await db.select().from(domains).where(eq(domains.id, domainId))).toHaveLength(1);
  });

  it("keeps the row when a pending move's identity can't be dropped", async () => {
    const { providerId } = await addProvider(fixture, {
      providerAdapter: "ses",
      credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", region: "us-west-2" },
    });
    const created = (await (await createDomain()).json()) as SerializedDomain;
    await db
      .update(domains)
      .set({ pendingProviderId: providerId, pendingProviderDomainId: "example.net", pendingStartedAt: new Date() })
      .where(eq(domains.id, created.id));
    sesSend.mockReset();
    sesSend.mockRejectedValue(Object.assign(new Error("Rate exceeded."), { name: "TooManyRequestsException" }));

    const response = await remove(request(fixture.secret, `/${created.id}`, "DELETE"), routeContext(created.id));

    expect(response.status).toBe(503);
    const [after] = await db.select().from(domains).where(eq(domains.id, created.id));
    expect(after?.pendingProviderId).toBe(providerId);
  });

  it("drops the row when the provider already forgot the identity", async () => {
    const { providerId } = await addProvider(fixture, {
      providerAdapter: "ses",
      credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", region: "us-west-2" },
    });
    const { domainId } = await addDomainKeyFor(fixture, providerId, "gone.example.net");
    sesSend.mockReset();
    sesSend.mockRejectedValue(Object.assign(new Error("Email identity does not exist."), { name: "NotFoundException" }));

    const response = await remove(request(fixture.secret, `/${domainId}`, "DELETE"), routeContext(domainId));

    expect(response.status).toBe(200);
    expect(await db.select().from(domains).where(eq(domains.id, domainId))).toHaveLength(0);
  });

  it.each([
    {
      kind: "a list",
      name: "bulk.example.net",
      message: "Announcements",
      detail: { lists: ["Announcements"] },
      seed: (domainId: string) =>
        db.insert(lists).values({
          id: newId("list"),
          organizationId: fixture.organizationId,
          domainId,
          name: "Announcements",
        }),
    },
    {
      kind: "a batch",
      name: "sent.example.net",
      message: "batches",
      detail: undefined,
      seed: (domainId: string) =>
        db.insert(batches).values({
          id: newId("batch"),
          organizationId: fixture.organizationId,
          domainId,
          fromAddress: "ada@sent.example.net",
          subject: "Weekly",
          recipientCount: 0,
        }),
    },
  ])("refuses a domain with $kind and never reaches the provider", async ({ name, message, detail, seed }) => {
    const { providerId } = await addProvider(fixture, {
      providerAdapter: "ses",
      credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", region: "us-west-2" },
    });
    const { domainId } = await addDomainKeyFor(fixture, providerId, name);
    await seed(domainId);
    sesSend.mockReset();
    sesSend.mockResolvedValue({});

    const response = await remove(request(fixture.secret, `/${domainId}`, "DELETE"), routeContext(domainId));
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("domain_in_use");
    expect(body.error.message).toContain(message);
    expect(body.error.detail).toEqual(detail);
    expect(sesSend).not.toHaveBeenCalled();
    expect(await db.select().from(domains).where(eq(domains.id, domainId))).toHaveLength(1);
  });
});
