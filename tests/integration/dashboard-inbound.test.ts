import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, inboundMessages, webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import type { WebhookDeliveryStatus } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import {
  inboundByDay,
  latestInboundDeliveries,
  listInboundFilterDomains,
  readInboundForOrg,
} from "@/lib/dashboard/inbound";
import { redeliverInbound } from "@/lib/inbound/redeliver";
import { addDomainKey, resetDatabase, seedFixture, type Fixture } from "./fixtures";

const DAY = 86_400_000;
const NOW = new Date("2026-09-29T12:00:00Z");

let fixture: Fixture;

async function receive(domainId: string, receivedAt: Date): Promise<string> {
  const id = newId("inbound");
  await db.insert(inboundMessages).values({
    id,
    organizationId: fixture.organizationId,
    domainId,
    fromAddress: "ada@example.net",
    to: ["support@example.com"],
    threadId: newId("thread"),
    receivedAt,
    expiresAt: new Date(receivedAt.getTime() + 7 * DAY),
  });
  return id;
}

async function deliver(endpointId: string, inboundId: string, status: WebhookDeliveryStatus, createdAt: Date): Promise<void> {
  await db.insert(webhookDeliveries).values({
    id: newId("webhookDelivery"),
    organizationId: fixture.organizationId,
    endpointId,
    eventType: "inbound.received",
    payload: { id: newId("event"), type: "inbound.received", data: { id: inboundId } },
    status,
    attempts: 1,
    lastStatusCode: status === "succeeded" ? 200 : 503,
    expiresAt: new Date(createdAt.getTime() + DAY),
    createdAt,
  });
}

async function endpoint(): Promise<string> {
  const id = newId("webhookEndpoint");
  await db.insert(webhookEndpoints).values({
    id,
    organizationId: fixture.organizationId,
    domainId: fixture.domainId,
    url: "https://hooks.example.com/inbound",
    events: ["inbound.received"],
    secretEncrypted: "x",
  });
  return id;
}

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

describe("inbound per day", () => {
  it("zero-fills the window and scopes to a domain", async () => {
    const other = await addDomainKey(fixture);
    await receive(fixture.domainId, new Date(NOW.getTime() - 2 * 3600_000));
    await receive(fixture.domainId, new Date(NOW.getTime() - 3 * 3600_000));
    await receive(other.domainId, new Date(NOW.getTime() - 3 * DAY));
    await receive(fixture.domainId, new Date(NOW.getTime() - 40 * DAY));

    const all = await inboundByDay(fixture.organizationId, "UTC", { now: NOW });
    expect(all).toHaveLength(31);
    expect(all.at(-1)).toEqual({ date: new Date("2026-09-29T00:00:00Z"), received: 2 });
    expect(all.reduce((sum, day) => sum + day.received, 0)).toBe(3);

    const one = await inboundByDay(fixture.organizationId, "UTC", { domainId: other.domainId, now: NOW });
    expect(one.reduce((sum, day) => sum + day.received, 0)).toBe(1);
  });
});

describe("inbound webhook deliveries", () => {
  it("reads the newest delivery per message and leaves out one with none", async () => {
    const hook = await endpoint();
    const redelivered = await receive(fixture.domainId, NOW);
    const failed = await receive(fixture.domainId, NOW);
    const none = await receive(fixture.domainId, NOW);
    await deliver(hook, redelivered, "exhausted", new Date(NOW.getTime() + 1000));
    await deliver(hook, redelivered, "succeeded", new Date(NOW.getTime() + 60_000));
    await deliver(hook, failed, "failed", new Date(NOW.getTime() + 1000));

    const byId = await latestInboundDeliveries(
      fixture.organizationId,
      [redelivered, failed, none].map((id) => ({ id, receivedAt: NOW })),
    );
    expect(byId[redelivered]?.status).toBe("succeeded");
    expect(byId[failed]).toMatchObject({ status: "failed", lastStatusCode: 503 });
    expect(byId[none]).toBeUndefined();

    const detail = await readInboundForOrg(fixture.organizationId, failed);
    expect(detail?.delivery?.status).toBe("failed");
  });
});

describe("inbound domain filter", () => {
  it("lists domains with inbound on or mail still held", async () => {
    const held = await addDomainKey(fixture, "held.example.com");
    await addDomainKey(fixture, "quiet.example.com");
    await db.update(domains).set({ inboundEnabled: true }).where(eq(domains.id, fixture.domainId));
    await receive(held.domainId, NOW);

    const names = (await listInboundFilterDomains(fixture.organizationId)).map((option) => option.name);
    expect(names).toHaveLength(2);
    expect(names).toContain("held.example.com");
    expect(names).not.toContain("quiet.example.com");
  });
});

describe("redelivering inbound", () => {
  it("queues the domain's webhook again, and refuses with no endpoint or message", async () => {
    const id = await receive(fixture.domainId, NOW);
    expect(await redeliverInbound(fixture.organizationId, id)).toBe(false);

    const hook = await endpoint();
    expect(await redeliverInbound(fixture.organizationId, id)).toBe(true);
    expect(await redeliverInbound(fixture.organizationId, newId("inbound"))).toBe(false);

    const queued = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, hook));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ eventType: "inbound.received", status: "pending" });
    expect((queued[0]?.payload as { data: { id: string } }).data.id).toBe(id);
  });
});
