import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys } from "@/lib/db/schema";
import { createApiKey } from "@/lib/api/key-lifecycle";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { acceptMessage } from "@/lib/messages/create";
import { streamEventsForKey } from "@/lib/messages/stream";
import { createEndpoint } from "@/lib/webhooks/endpoints";
import { GET as listKeys } from "@/app/api/v1/keys/route";
import { DELETE as revokeKey, GET as readKey, PATCH as updateKey } from "@/app/api/v1/keys/[id]/route";
import { GET as listEndpoints, POST as createEndpointRoute } from "@/app/api/v1/webhook_endpoints/route";
import { GET as readEndpoint } from "@/app/api/v1/webhook_endpoints/[id]/route";
import { GET as listEmails } from "@/app/api/v1/emails/route";
import { GET as readEmail } from "@/app/api/v1/emails/[id]/route";
import { GET as listInbound } from "@/app/api/v1/inbound/route";
import { GET as listExports, POST as createExport } from "@/app/api/v1/exports/route";
import { resetDatabase, routeContext, seedFixture, type Fixture } from "./fixtures";

vi.mock("node:dns/promises", () => ({ lookup: () => Promise.resolve([{ address: "203.0.113.9", family: 4 }]) }));

let fixture: Fixture;
let sandbox: { key: OrganizationKeyRow; secret: string };

function call(secret: string, path: string, method = "GET", body?: unknown): Request {
  return new Request(`http://localhost/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function send(key: OrganizationKeyRow): Promise<string> {
  const { message } = await acceptMessage(key, { from: "ada@example.com", to: ["person@example.net"], subject: "Hi", text: "hi" }, null);
  return message.id;
}

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  fixture = await seedFixture({ scopeToDomain: false });
  const minted = await createApiKey({ organizationId: fixture.organizationId, name: "sandbox", mode: "test", domainIds: [] });
  sandbox = { key: minted.key as OrganizationKeyRow, secret: minted.secret };
});

describe("a test key", () => {
  it("lists only test keys, and can't read, widen or revoke a live one", async () => {
    const listed = (await (await listKeys(call(sandbox.secret, "/keys"))).json()) as { data: { id: string }[] };
    expect(listed.data.map((key) => key.id)).toEqual([sandbox.key.id]);

    const live = fixture.key.id;
    expect((await readKey(call(sandbox.secret, `/keys/${live}`), routeContext(live))).status).toBe(404);
    expect((await updateKey(call(sandbox.secret, `/keys/${live}`, "PATCH", { domain_ids: [] }), routeContext(live))).status).toBe(404);
    expect((await revokeKey(call(sandbox.secret, `/keys/${live}`, "DELETE"), routeContext(live))).status).toBe(404);

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, live));
    expect(row?.revokedAt).toBeNull();
  });

  it("can't attach an endpoint to a live key or see a live key's endpoints", async () => {
    const { endpoint } = await createEndpoint({ organizationId: fixture.organizationId, apiKeyId: fixture.key.id, url: "https://example.net/live", events: ["email.delivered"] });

    const created = await createEndpointRoute(call(sandbox.secret, "/webhook_endpoints", "POST", { key_id: fixture.key.id, url: "https://example.net/steal", events: ["email.delivered"] }));
    expect(created.status).toBe(404);

    const listed = (await (await listEndpoints(call(sandbox.secret, "/webhook_endpoints"))).json()) as { data: unknown[] };
    expect(listed.data).toEqual([]);
    expect((await readEndpoint(call(sandbox.secret, `/webhook_endpoints/${endpoint.id}`), routeContext(endpoint.id))).status).toBe(404);
  });

  it("reads only test mail, in lists, by id and in the event stream", async () => {
    const liveId = await send(fixture.key);
    const testId = await send(sandbox.key);

    const listed = (await (await listEmails(call(sandbox.secret, "/emails"))).json()) as { data: { id: string }[] };
    expect(listed.data.map((message) => message.id)).toEqual([testId]);
    expect((await readEmail(call(sandbox.secret, `/emails/${liveId}`), routeContext(liveId))).status).toBe(404);
    expect((await readEmail(call(sandbox.secret, `/emails/${testId}`), routeContext(testId))).status).toBe(200);

    const events = await streamEventsForKey({ organizationId: fixture.organizationId, domainIds: [], mode: "test" });
    expect(new Set(events.map((row) => row.message.id))).toEqual(new Set([testId]));

    const liveList = (await (await listEmails(call(fixture.secret, "/emails"))).json()) as { data: { id: string }[] };
    expect(liveList.data.map((message) => message.id).sort()).toEqual([liveId, testId].sort());
  });

  it("can't reach live mail by filtering on a live key", async () => {
    await send(fixture.key);
    const testId = await send(sandbox.key);

    const byLive = (await (await listEmails(call(sandbox.secret, `/emails?key=${fixture.key.id}`))).json()) as { data: unknown[] };
    expect(byLive.data).toEqual([]);

    const read = (await (await readEmail(call(sandbox.secret, `/emails/${testId}`), routeContext(testId))).json()) as { key_id: string | null };
    expect(read.key_id).toBe(sandbox.key.id);
  });

  it("can't read received mail or exports", async () => {
    for (const response of [
      await listInbound(call(sandbox.secret, "/inbound")),
      await listExports(call(sandbox.secret, "/exports")),
      await createExport(call(sandbox.secret, "/exports", "POST", { kind: "log_csv" })),
    ]) {
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("key_not_scoped");
    }
  });
});
