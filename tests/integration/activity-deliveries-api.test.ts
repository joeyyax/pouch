import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { inboundMessages, webhookAttempts, webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import { apiKeyActor, recordActivity, userActor, workerActor } from "@/lib/activity/record";
import { listActivity } from "@/lib/activity/query";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { latestInboundDeliveries } from "@/lib/dashboard/inbound";
import { newId } from "@/lib/ids";
import { scrubInboundPayloads } from "@/lib/inbound/payloads";
import { GET as listActivityRoute } from "@/app/api/v1/activity/route";
import { GET as listInboundRoute } from "@/app/api/v1/inbound/route";
import { GET as readInboundRoute } from "@/app/api/v1/inbound/[id]/route";
import { GET as readActivityRoute } from "@/app/api/v1/activity/[id]/route";
import { GET as listDeliveriesRoute } from "@/app/api/v1/webhook_endpoints/[id]/deliveries/route";
import { GET as readDeliveryRoute } from "@/app/api/v1/webhook_endpoints/[id]/deliveries/[deliveryId]/route";
import { addDomainKey, apiRequest, resetDatabase, routeContext, seedFixture, type Fixture } from "./fixtures";

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  fixture = await seedFixture({ scopeToDomain: false });
});

async function body(response: Response, status = 200): Promise<Record<string, unknown>> {
  expect(response.status).toBe(status);
  return (await response.json()) as Record<string, unknown>;
}

describe("GET /v1/activity", () => {
  async function seedActivity(): Promise<void> {
    await recordActivity({
      organizationId: fixture.organizationId,
      action: "domain.added",
      actor: userActor("u_1", "Ada"),
      appliesTo: fixture.domainId,
      subjectLabel: "example.com",
    });
    await recordActivity({
      organizationId: fixture.organizationId,
      action: "key.rate_limit.changed",
      actor: apiKeyActor(fixture.key.id, "test"),
      appliesTo: fixture.key.id,
      subjectLabel: "test",
      metadata: { from: 100, to: 200, apiKeyId: fixture.key.id },
    });
    await recordActivity({ organizationId: fixture.organizationId, action: "system.endpoint.auto_disabled", actor: workerActor("worker") });
  }

  it("pages the log newest first, the same rows the screen reads", async () => {
    await seedActivity();
    const first = await body(await listActivityRoute(apiRequest(fixture.secret, "/v1/activity?limit=2")));
    const data = first.data as Record<string, unknown>[];
    expect(data.map((row) => row.action)).toEqual(["system.endpoint.auto_disabled", "key.rate_limit.changed"]);
    expect(data[1]).toMatchObject({
      family: "key",
      outcome: "success",
      actor: { type: "api_key", id: fixture.key.id, label: "test" },
      applies_to: fixture.key.id,
      subject_label: "test",
      metadata: { from: 100, to: 200, api_key_id: fixture.key.id },
    });

    const second = await body(await listActivityRoute(apiRequest(fixture.secret, `/v1/activity?limit=2&cursor=${first.next_cursor}`)));
    expect((second.data as Record<string, unknown>[]).map((row) => row.action)).toEqual(["domain.added"]);
    expect(second.next_cursor).toBeNull();

    const screen = await listActivity(fixture.organizationId, { families: [], outcomes: [], actors: [], since: null });
    expect(screen.rows.map((row) => row.id)).toEqual([...data, ...(second.data as Record<string, unknown>[])].map((row) => row.id));
  });

  it("filters by family, outcome and actor the way the screen does", async () => {
    await seedActivity();
    const byFamily = await body(await listActivityRoute(apiRequest(fixture.secret, "/v1/activity?family=domain,key")));
    expect((byFamily.data as Record<string, unknown>[]).map((row) => row.action)).toEqual(["key.rate_limit.changed", "domain.added"]);

    const byActor = await body(await listActivityRoute(apiRequest(fixture.secret, "/v1/activity?actor=user:u_1,worker:worker")));
    expect((byActor.data as Record<string, unknown>[]).map((row) => row.action)).toEqual(["system.endpoint.auto_disabled", "domain.added"]);

    const unknown = await body(await listActivityRoute(apiRequest(fixture.secret, "/v1/activity?family=nope")), 422);
    expect(unknown.error).toMatchObject({ code: "validation_failed", field: "family" });
  });

  it("reads one entry, trims with fields, and refuses a key limited to domains", async () => {
    await seedActivity();
    const page = await body(await listActivityRoute(apiRequest(fixture.secret, "/v1/activity?limit=1")));
    const id = (page.data as { id: string }[])[0]!.id;

    const one = await body(await readActivityRoute(apiRequest(fixture.secret, `/v1/activity/${id}?fields=action`), routeContext(id)));
    expect(one).toEqual({ id, action: "system.endpoint.auto_disabled" });

    const other = await seedFixture({ scopeToDomain: false });
    await body(await readActivityRoute(apiRequest(other.secret, `/v1/activity/${id}`), routeContext(id)), 404);

    const scoped = await addDomainKey(fixture);
    const refused = await body(await listActivityRoute(apiRequest(scoped.secret, "/v1/activity")), 403);
    expect(refused.error).toMatchObject({ code: "key_not_scoped" });
  });
});

describe("GET /v1/webhook_endpoints/:id/deliveries", () => {
  async function seedDelivery(eventType: "email.delivered" | "address.received", payload: Record<string, unknown>) {
    const endpointId = newId("webhookEndpoint");
    await db.insert(webhookEndpoints).values({
      id: endpointId,
      organizationId: fixture.organizationId,
      apiKeyId: fixture.key.id,
      url: "https://hooks.example.com/events",
      events: [eventType],
      secretEncrypted: "x",
    });
    const deliveryId = newId("webhookDelivery");
    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      organizationId: fixture.organizationId,
      endpointId,
      eventType,
      payload,
      status: "pending",
      attempts: 2,
      lastStatusCode: 503,
      nextAttemptAt: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    for (const attempt of [1, 2]) {
      await db.insert(webhookAttempts).values({
        id: newId("webhookAttempt"),
        organizationId: fixture.organizationId,
        deliveryId,
        attempt,
        statusCode: 503,
        durationMs: 100 * attempt,
      });
    }
    return { endpointId, deliveryId };
  }

  const deliveryContext = (id: string, deliveryId: string) => ({ params: Promise.resolve({ id, deliveryId }) });

  it("lists without payloads, adds them by name, and reads one with its attempts", async () => {
    const { endpointId, deliveryId } = await seedDelivery("email.delivered", { type: "email.delivered", data: { id: "msg_1" } });

    const list = await body(await listDeliveriesRoute(apiRequest(fixture.secret, `/v1/webhook_endpoints/${endpointId}/deliveries`), routeContext(endpointId)));
    const [row] = list.data as Record<string, unknown>[];
    expect(row).toMatchObject({ id: deliveryId, endpoint_id: endpointId, status: "pending", attempt_count: 2, last_status_code: 503 });
    expect(row).not.toHaveProperty("payload");
    expect(row).not.toHaveProperty("attempts");

    const included = await body(
      await listDeliveriesRoute(apiRequest(fixture.secret, `/v1/webhook_endpoints/${endpointId}/deliveries?include=payload,attempts`), routeContext(endpointId)),
    );
    expect((included.data as Record<string, unknown>[])[0]).toMatchObject({ payload: { type: "email.delivered" }, attempts: [{ attempt: 1 }, { attempt: 2 }] });

    const one = await body(
      await readDeliveryRoute(apiRequest(fixture.secret, `/v1/webhook_endpoints/${endpointId}/deliveries/${deliveryId}`), deliveryContext(endpointId, deliveryId)),
    );
    expect(one).toMatchObject({ id: deliveryId, payload: { data: { id: "msg_1" } } });
    expect((one.attempts as Record<string, unknown>[]).map((attempt) => attempt.duration_ms)).toEqual([100, 200]);
    expect(typeof one.next_attempt_at).toBe("string");
  });

  it("reads a purged message's payload without its body", async () => {
    const inboundId = newId("inbound");
    const { endpointId, deliveryId } = await seedDelivery("address.received", {
      type: "address.received",
      data: { id: inboundId, text: "secret text", html: "<p>secret</p>" },
    });
    await scrubInboundPayloads(db, [{ id: inboundId, organizationId: fixture.organizationId, receivedAt: new Date(Date.now() - 60_000) }]);

    const one = await body(
      await readDeliveryRoute(
        apiRequest(fixture.secret, `/v1/webhook_endpoints/${endpointId}/deliveries/${deliveryId}?fields=payload`),
        deliveryContext(endpointId, deliveryId),
      ),
    );
    expect(one.payload).toEqual({ type: "address.received", data: { id: inboundId, text: null, html: null } });
  });

  it("answers 404 for another organization's endpoint and for a delivery on another endpoint", async () => {
    const { endpointId, deliveryId } = await seedDelivery("email.delivered", { type: "email.delivered" });
    const second = await seedDelivery("email.delivered", { type: "email.delivered" });

    const other = await seedFixture({ scopeToDomain: false });
    await body(await listDeliveriesRoute(apiRequest(other.secret, `/v1/webhook_endpoints/${endpointId}/deliveries`), routeContext(endpointId)), 404);
    await body(
      await readDeliveryRoute(
        apiRequest(fixture.secret, `/v1/webhook_endpoints/${second.endpointId}/deliveries/${deliveryId}`),
        deliveryContext(second.endpointId, deliveryId),
      ),
      404,
    );
  });
});

describe("include=delivery on inbound reads", () => {
  it("returns the newest delivery to the domain's webhook, the one the inbound screen shows", async () => {
    const endpointId = newId("webhookEndpoint");
    await db.insert(webhookEndpoints).values({
      id: endpointId,
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      url: "https://hooks.example.com/inbound",
      events: ["inbound.received"],
      secretEncrypted: "x",
    });
    const receivedAt = new Date(Date.now() - 60_000);
    const delivered = newId("inbound");
    const quiet = newId("inbound");
    for (const id of [delivered, quiet]) {
      await db.insert(inboundMessages).values({
        id,
        organizationId: fixture.organizationId,
        domainId: fixture.domainId,
        fromAddress: "ada@example.net",
        to: ["support@example.com"],
        threadId: newId("thread"),
        receivedAt,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    }
    for (const [status, offset] of [["exhausted", 1_000], ["succeeded", 2_000]] as const) {
      await db.insert(webhookDeliveries).values({
        id: newId("webhookDelivery"),
        organizationId: fixture.organizationId,
        endpointId,
        eventType: "inbound.received",
        payload: { type: "inbound.received", data: { id: delivered } },
        status,
        attempts: 1,
        lastStatusCode: status === "succeeded" ? 200 : 503,
        expiresAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date(receivedAt.getTime() + offset),
      });
    }

    const plain = await body(await readInboundRoute(apiRequest(fixture.secret, `/v1/inbound/${delivered}`), routeContext(delivered)));
    expect(plain).not.toHaveProperty("delivery");

    const one = await body(await readInboundRoute(apiRequest(fixture.secret, `/v1/inbound/${delivered}?include=delivery`), routeContext(delivered)));
    expect(one.delivery).toMatchObject({ endpoint_id: endpointId, status: "succeeded", last_status_code: 200 });
    expect(one.delivery).not.toHaveProperty("payload");

    const list = await body(await listInboundRoute(apiRequest(fixture.secret, "/v1/inbound?fields=delivery")));
    const byId = Object.fromEntries((list.data as { id: string }[]).map((row) => [row.id, row]));
    expect(byId[delivered]).toEqual({ id: delivered, delivery: expect.objectContaining({ status: "succeeded" }) });
    expect(byId[quiet]).toEqual({ id: quiet, delivery: null });

    const screen = await latestInboundDeliveries(fixture.organizationId, [{ id: delivered, receivedAt }]);
    expect(screen[delivered]).toMatchObject({ status: "succeeded", lastStatusCode: 200 });
  });
});
