import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, apiKeys, webhookEndpoints } from "@/lib/db/schema";
import { authenticateKey } from "@/lib/api/keys";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { GET as keysGET, POST as keysPOST } from "@/app/api/v1/keys/route";
import { DELETE as keyDELETE, GET as keyGET, PATCH as keyPATCH } from "@/app/api/v1/keys/[id]/route";
import { GET as endpointsGET, POST as endpointsPOST } from "@/app/api/v1/webhook_endpoints/route";
import {
  DELETE as endpointDELETE,
  GET as endpointGET,
  PATCH as endpointPATCH,
} from "@/app/api/v1/webhook_endpoints/[id]/route";
import { POST as rotatePOST } from "@/app/api/v1/webhook_endpoints/[id]/rotate_secret/route";
import { GET as organizationGET, PATCH as organizationPATCH } from "@/app/api/v1/organization/route";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

// The real check resolves DNS. `private.example.com` stands in for a host that fails it.
vi.mock("@/lib/webhooks/ssrf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/webhooks/ssrf")>();
  return {
    ...actual,
    resolvePublicTarget: async (url: string) => {
      if (new URL(url).hostname.startsWith("private.")) {
        throw new actual.UnsafeWebhookUrlError("That host resolves to a private address.");
      }
      return { url, address: "203.0.113.10", family: 4 };
    },
  };
});

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  fixture = await seedFixture({ scopeToDomain: false });
});

function get(secret: string, path: string): Request {
  return new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${secret}` } });
}

function send(secret: string, path: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

interface KeyBody {
  id: string;
  name: string;
  mode: string;
  secret: string;
  secret_prefix: string;
  domain_ids: string[];
  rate_limit: number;
  revoked_at: string | null;
}

async function mint(overrides: Record<string, unknown> = {}): Promise<KeyBody> {
  const response = await keysPOST(send(fixture.secret, "/v1/keys", "POST", { name: "minted", ...overrides }));
  expect(response.status).toBe(201);
  return body<KeyBody>(response);
}

describe("POST /v1/keys", () => {
  it("returns the secret once and stores only its hash", async () => {
    const key = await mint({ domain_ids: [fixture.domainId], rate_limit: 120 });

    expect(key.secret.startsWith("sk_")).toBe(true);
    expect(key.domain_ids).toEqual([fixture.domainId]);
    expect(key.rate_limit).toBe(120);

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, key.id)).limit(1);
    expect(JSON.stringify(row)).not.toContain(key.secret);

    const read = await body<KeyBody>(await keyGET(get(fixture.secret, `/v1/keys/${key.id}`), params(key.id)));
    expect(read.secret).toBeUndefined();
    expect(read.secret_prefix).toBe(key.secret.slice(0, 16));
  });

  it("records the mint on the organization's activity, as an api_key actor", async () => {
    const key = await mint();
    const [row] = await db
      .select()
      .from(activity)
      .where(and(eq(activity.organizationId, fixture.organizationId), eq(activity.action, "key.created")))
      .limit(1);
    expect(row).toMatchObject({ actorType: "api_key", appliesTo: key.id });
  });

  it("refuses a key limited to domains", async () => {
    const limited = await seedFixture();
    const response = await keysPOST(send(limited.secret, "/v1/keys", "POST", { name: "escalate" }));
    expect(response.status).toBe(403);
    expect((await body<{ error: { code: string } }>(response)).error.code).toBe("key_not_scoped");
  });

  it("refuses a test key minting a live key, and allows a test one", async () => {
    const test = await seedFixture({ keyMode: "test", scopeToDomain: false });
    const refused = await keysPOST(send(test.secret, "/v1/keys", "POST", { name: "promote", mode: "live" }));
    expect(refused.status).toBe(422);
    expect((await body<{ error: { code: string; field: string } }>(refused)).error).toMatchObject({
      code: "validation_failed",
      field: "mode",
    });

    const allowed = await keysPOST(send(test.secret, "/v1/keys", "POST", { name: "sandbox", mode: "test" }));
    expect(allowed.status).toBe(201);
  });

  it("refuses a domain in another organization", async () => {
    const other = await seedFixture();
    const response = await keysPOST(
      send(fixture.secret, "/v1/keys", "POST", { name: "elsewhere", domain_ids: [other.domainId] }),
    );
    expect(response.status).toBe(404);
  });
});

describe("GET /v1/keys", () => {
  it("pages newest first and carries a cursor", async () => {
    await mint({ name: "one" });
    await mint({ name: "two" });

    const page = await body<{ data: KeyBody[]; next_cursor: string | null }>(
      await keysGET(get(fixture.secret, "/v1/keys?limit=2")),
    );
    expect(page.data.map((key) => key.name)).toEqual(["two", "one"]);
    expect(page.next_cursor).toBe(page.data[1]!.id);
  });

  it("filters by mode and by whether the key is revoked", async () => {
    const test = await seedFixture({ keyMode: "test", scopeToDomain: false });
    const gone = await mint({ name: "gone" });
    await keyDELETE(send(fixture.secret, `/v1/keys/${gone.id}`, "DELETE"), params(gone.id));

    const live = await body<{ data: KeyBody[] }>(await keysGET(get(fixture.secret, "/v1/keys?mode=live&revoked=false")));
    expect(live.data.map((key) => key.id)).not.toContain(gone.id);

    const revoked = await body<{ data: KeyBody[] }>(await keysGET(get(fixture.secret, "/v1/keys?revoked=true")));
    expect(revoked.data.map((key) => key.id)).toEqual([gone.id]);

    const inTestMode = await body<{ data: KeyBody[] }>(await keysGET(get(test.secret, "/v1/keys?mode=test")));
    expect(inTestMode.data.map((key) => key.id)).toEqual([test.key.id]);
  });
});

describe("PATCH and DELETE /v1/keys/:id", () => {
  it("edits the scope and records the change", async () => {
    const key = await mint();
    const updated = await body<KeyBody>(
      await keyPATCH(send(fixture.secret, `/v1/keys/${key.id}`, "PATCH", { domain_ids: [fixture.domainId] }), params(key.id)),
    );
    expect(updated.domain_ids).toEqual([fixture.domainId]);

    const rows = await db.select().from(activity).where(eq(activity.action, "key.rescoped"));
    expect(rows).toHaveLength(1);
  });

  it("refuses an empty patch", async () => {
    const key = await mint();
    const response = await keyPATCH(send(fixture.secret, `/v1/keys/${key.id}`, "PATCH", {}), params(key.id));
    expect(response.status).toBe(422);
  });

  it("revokes, stops the secret authenticating and keeps the row", async () => {
    const key = await mint();
    expect((await authenticateKey(get(key.secret, "/v1/emails"))).id).toBe(key.id);
    const revoked = await body<KeyBody>(
      await keyDELETE(send(fixture.secret, `/v1/keys/${key.id}`, "DELETE"), params(key.id)),
    );
    expect(revoked.revoked_at).not.toBeNull();

    await expect(authenticateKey(get(key.secret, "/v1/emails"))).rejects.toMatchObject({ code: "invalid_key" });
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, key.id)).limit(1);
    expect(row).toBeTruthy();
  });

  it("lets a key revoke itself, so a leaked one can burn itself without the dashboard", async () => {
    const revoked = await body<KeyBody>(
      await keyDELETE(send(fixture.secret, `/v1/keys/${fixture.key.id}`, "DELETE"), params(fixture.key.id)),
    );
    expect(revoked.revoked_at).not.toBeNull();

    await expect(authenticateKey(get(fixture.secret, "/v1/emails"))).rejects.toMatchObject({ code: "invalid_key" });
  });

  it("won't reach another organization's key", async () => {
    const other = await seedFixture();
    const response = await keyGET(get(fixture.secret, `/v1/keys/${other.key.id}`), params(other.key.id));
    expect(response.status).toBe(404);
  });
});

interface EndpointBody {
  id: string;
  key_id: string;
  url: string;
  events: string[];
  disabled: boolean;
  secret: string;
}

async function register(overrides: Record<string, unknown> = {}): Promise<EndpointBody> {
  const response = await endpointsPOST(
    send(fixture.secret, "/v1/webhook_endpoints", "POST", {
      key_id: fixture.key.id,
      url: "https://hooks.example.com/pouch",
      events: ["email.delivered"],
      ...overrides,
    }),
  );
  expect(response.status).toBe(201);
  return body<EndpointBody>(response);
}

describe("/v1/webhook_endpoints", () => {
  it("returns the signing secret once and never again, and stores it encrypted", async () => {
    const endpoint = await register();
    expect(endpoint.secret.startsWith("whsec_")).toBe(true);

    const read = await body<EndpointBody>(
      await endpointGET(get(fixture.secret, `/v1/webhook_endpoints/${endpoint.id}`), params(endpoint.id)),
    );
    expect(read.secret).toBeUndefined();
    expect(read.url).toBe("https://hooks.example.com/pouch");

    const [row] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpoint.id)).limit(1);
    expect(row?.secretEncrypted).not.toContain(endpoint.secret);

    const listed = await body<{ data: EndpointBody[] }>(
      await endpointsGET(get(fixture.secret, "/v1/webhook_endpoints")),
    );
    expect(listed.data.every((row) => row.secret === undefined)).toBe(true);
  });

  it("rotates to a new secret", async () => {
    const endpoint = await register();
    const rotated = await body<EndpointBody>(
      await rotatePOST(send(fixture.secret, `/v1/webhook_endpoints/${endpoint.id}/rotate_secret`, "POST"), params(endpoint.id)),
    );
    expect(rotated.secret).not.toBe(endpoint.secret);
    expect(rotated.id).toBe(endpoint.id);
  });

  it("disables and re-enables without touching the secret", async () => {
    const endpoint = await register();
    const disabled = await body<EndpointBody>(
      await endpointPATCH(send(fixture.secret, `/v1/webhook_endpoints/${endpoint.id}`, "PATCH", { disabled: true }), params(endpoint.id)),
    );
    expect(disabled.disabled).toBe(true);

    const enabled = await body<EndpointBody>(
      await endpointPATCH(send(fixture.secret, `/v1/webhook_endpoints/${endpoint.id}`, "PATCH", { disabled: false }), params(endpoint.id)),
    );
    expect(enabled.disabled).toBe(false);
  });

  it("answers validation_failed when the URL check refuses the host", async () => {
    const response = await endpointsPOST(
      send(fixture.secret, "/v1/webhook_endpoints", "POST", {
        key_id: fixture.key.id,
        url: "https://private.example.com/hook",
        events: ["email.delivered"],
      }),
    );
    expect(response.status).toBe(422);
    expect((await body<{ error: { code: string; field: string } }>(response)).error).toMatchObject({
      code: "validation_failed",
      field: "url",
    });
  });

  it("refuses a key that isn't in the organization", async () => {
    const other = await seedFixture();
    const response = await endpointsPOST(
      send(fixture.secret, "/v1/webhook_endpoints", "POST", {
        key_id: other.key.id,
        url: "https://hooks.example.com/pouch",
        events: ["email.delivered"],
      }),
    );
    expect(response.status).toBe(404);
  });

  it("deletes", async () => {
    const endpoint = await register();
    const deleted = await body<{ deleted: boolean }>(
      await endpointDELETE(send(fixture.secret, `/v1/webhook_endpoints/${endpoint.id}`, "DELETE"), params(endpoint.id)),
    );
    expect(deleted.deleted).toBe(true);

    const gone = await endpointGET(get(fixture.secret, `/v1/webhook_endpoints/${endpoint.id}`), params(endpoint.id));
    expect(gone.status).toBe(404);
  });

  it("won't change, rotate or delete another organization's endpoint", async () => {
    const other = await seedFixture({ scopeToDomain: false });
    const theirs = await body<EndpointBody>(
      await endpointsPOST(
        send(other.secret, "/v1/webhook_endpoints", "POST", {
          key_id: other.key.id,
          url: "https://hooks.example.com/theirs",
          events: ["email.delivered"],
        }),
      ),
    );
    const [before] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, theirs.id));

    const path = `/v1/webhook_endpoints/${theirs.id}`;
    const patched = await endpointPATCH(send(fixture.secret, path, "PATCH", { url: "https://hooks.example.com/ours", disabled: true }), params(theirs.id));
    const rotated = await rotatePOST(send(fixture.secret, `${path}/rotate_secret`, "POST"), params(theirs.id));
    const deleted = await endpointDELETE(send(fixture.secret, path, "DELETE"), params(theirs.id));

    expect([patched.status, rotated.status, deleted.status]).toEqual([404, 404, 404]);
    const [after] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, theirs.id));
    expect(after).toEqual(before);
  });

  it("never lists a domain's inbound endpoint", async () => {
    const { upsertDomainEndpoint } = await import("@/lib/webhooks/endpoints");
    const inbound = await upsertDomainEndpoint(fixture.organizationId, fixture.domainId, "https://hooks.example.com/inbound");

    const listed = await body<{ data: EndpointBody[] }>(await endpointsGET(get(fixture.secret, "/v1/webhook_endpoints")));
    expect(listed.data.map((row) => row.id)).not.toContain(inbound.endpoint.id);

    const read = await endpointGET(get(fixture.secret, `/v1/webhook_endpoints/${inbound.endpoint.id}`), params(inbound.endpoint.id));
    expect(read.status).toBe(404);
  });
});

interface OrganizationBody {
  id: string;
  name: string;
  slug: string;
  body_retention_days: number;
}

describe("/v1/organization", () => {
  it("reads the key's own organization", async () => {
    const organization = await body<OrganizationBody>(await organizationGET(get(fixture.secret, "/v1/organization")));
    expect(organization.id).toBe(fixture.organizationId);
    expect(organization.body_retention_days).toBeGreaterThan(0);
  });

  it("changes the name and the retention, recording each", async () => {
    const updated = await body<OrganizationBody>(
      await organizationPATCH(
        send(fixture.secret, "/v1/organization", "PATCH", { name: "Renamed", body_retention_days: 30 }),
      ),
    );
    expect(updated).toMatchObject({ name: "Renamed", body_retention_days: 30 });

    const actions = (await db.select().from(activity).where(eq(activity.organizationId, fixture.organizationId))).map(
      (row) => row.action,
    );
    expect(actions).toContain("settings.name.changed");
    expect(actions).toContain("settings.retention.changed");
  });

  it("refuses a retention outside the allowed range", async () => {
    const response = await organizationPATCH(
      send(fixture.secret, "/v1/organization", "PATCH", { body_retention_days: 3 }),
    );
    expect(response.status).toBe(422);
  });

  it("refuses a key limited to domains", async () => {
    const limited = await seedFixture();
    const response = await organizationGET(get(limited.secret, "/v1/organization"));
    expect(response.status).toBe(403);
  });
});
