import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { webhookEndpoints } from "@/lib/db/schema";
import { GET, PATCH } from "@/app/api/v1/domains/[id]/inbound/route";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

// The real check resolves DNS, which a test shouldn't depend on.
vi.mock("@/lib/webhooks/ssrf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/webhooks/ssrf")>();
  return {
    ...actual,
    resolvePublicTarget: async (url: string) => ({ url, address: "203.0.113.10", family: 4 }),
  };
});

interface InboundBody {
  enabled: boolean;
  webhook_url: string | null;
  webhook_secret?: string;
}

let fixture: Fixture;

function patch(body: unknown): Request {
  return new Request(`http://localhost/v1/domains/${fixture.domainId}/inbound`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${fixture.secret}` },
    body: JSON.stringify(body),
  });
}

function read(): Request {
  return new Request(`http://localhost/v1/domains/${fixture.domainId}/inbound`, {
    headers: { authorization: `Bearer ${fixture.secret}` },
  });
}

function context() {
  return { params: Promise.resolve({ id: fixture.domainId }) };
}

async function endpointRows() {
  return db
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.organizationId, fixture.organizationId), eq(webhookEndpoints.domainId, fixture.domainId)));
}

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  fixture = await seedFixture({ providerAdapter: "mailpace", domainStatus: "verified" });
});

describe("PATCH /v1/domains/:id/inbound — clearing the webhook URL", () => {
  it("keeps the URL when inbound is only disabled", async () => {
    await PATCH(patch({ enabled: true, webhook_url: "https://hooks.example.com/inbound" }), context());
    await PATCH(patch({ enabled: false }), context());

    const body = (await (await GET(read(), context())).json()) as InboundBody;
    expect(body.enabled).toBe(false);
    expect(body.webhook_url).toBe("https://hooks.example.com/inbound");
    expect(await endpointRows()).toHaveLength(1);
  });

  it("removes the endpoint when webhook_url is null, and stops reporting the URL", async () => {
    await PATCH(patch({ enabled: true, webhook_url: "https://hooks.example.com/inbound" }), context());

    const response = await PATCH(patch({ enabled: false, webhook_url: null }), context());
    expect(response.status).toBe(200);
    expect(((await response.json()) as InboundBody).webhook_url).toBeNull();

    const body = (await (await GET(read(), context())).json()) as InboundBody;
    expect(body.webhook_url).toBeNull();
    expect(await endpointRows()).toHaveLength(0);
  });

  it("refuses to enable inbound with no URL to deliver to", async () => {
    const response = await PATCH(patch({ enabled: true, webhook_url: null }), context());
    const body = (await response.json()) as { error: { code: string; field?: string } };

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.field).toBe("webhook_url");
  });
});
