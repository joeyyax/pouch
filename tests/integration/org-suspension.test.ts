import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import {
  activity,
  domains,
  messageEvents,
  messages,
  organizations,
  providers,
  type MessageStatus,
} from "@/lib/db/schema";
import { POST } from "@/app/api/v1/emails/route";
import { POST as postBatch } from "@/app/api/v1/batches/route";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { providerActor, userActor, workerActor } from "@/lib/activity/record";
import { encryptCredentials } from "@/lib/providers";
import { newId } from "@/lib/ids";
import { acceptMessage } from "@/lib/messages/create";
import { claimMessages, dueProviders } from "@/lib/messages/queue";
import { sendPushAlert } from "@/lib/notifications/push/push";
import { stallDomain } from "@/lib/domains/stall";
import { DEFAULT_STALL_LINES } from "@/lib/domains/guard";
import {
  releaseOrganizationSuspension,
  suspendOrganization,
  suspensionOf,
} from "@/lib/suspension";
import { resetRollupAlerts } from "@/lib/suspension/rollup";
import { messageHold } from "@/lib/messages/stall";
import { StallGuardLoop } from "@/worker/stall-guard";
import { deliver } from "@/worker/send";
import { releaseOrganizationAction, suspendOrganizationAction } from "@/app/(app)/admin/settings/organizations/actions";
import { listOrganizationsForOperator } from "@/lib/dashboard/admin-organizations";
import { addDomainKey, form, messageRow, resetDatabase, seedFixture, seedUser, type Fixture } from "./fixtures";

vi.mock("@/lib/notifications/push/push", () => ({ sendPushAlert: vi.fn().mockResolvedValue(undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const sessionState = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@/lib/auth/session", async () => (await import("./fixtures")).adminSessionModule(sessionState));

let fixture: Fixture;

const manual = { source: "manual" as const, reason: "Sending phishing lures." };
const valid = { from: "Ada <ada@example.com>", to: "person@example.net", subject: "Hello", html: "<p>Hi</p>" };

function post(secret: string, body: unknown): Request {
  return new Request("http://localhost/v1/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
}

async function queue(): Promise<string> {
  const { message } = await acceptMessage(fixture.key, { ...valid, to: ["person@example.net"] }, null);
  return message.id;
}

async function claimAll(workerId = "worker-a") {
  const claimed = [];
  for (const provider of await dueProviders()) {
    claimed.push(...(await claimMessages({ workerId, providerId: provider.id, limit: 50 })));
  }
  return claimed;
}

async function insertOutcomes(domainId: string, status: MessageStatus, count: number) {
  const now = await dbNow();
  const rows = Array.from({ length: count }, () => ({
    id: newId("message"),
    organizationId: fixture.organizationId,
    domainId,
    status,
    fromAddress: "hi@example.com",
    recipients: ["person@example.net"],
    subject: "Hello",
    envelope: {
      from: "hi@example.com",
      fromName: null,
      to: ["person@example.net"],
      cc: [],
      bcc: [],
      replyTo: [],
      headers: {},
      attachmentCount: 0,
    },
    tags: [],
    createdAt: now,
  }));
  await db.insert(messages).values(rows);
}

async function makeUser(admin: boolean): Promise<string> {
  const name = admin ? "Olive Admin" : "Regular Person";
  return (await seedUser({ organizationId: fixture.organizationId, admin, name })).userId;
}

function loop() {
  return new StallGuardLoop({ intervalMs: 60_000, batchSize: 10, recheckAfterMs: 0 });
}

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  await resetRollupAlerts();
  sessionState.userId = null;
  fixture = await seedFixture({ scopeToDomain: false });
  vi.mocked(sendPushAlert).mockClear();
});

describe("suspendOrganization", () => {
  it("records the suspension, its source and reason, in the activity log", async () => {
    const wrote = await suspendOrganization(fixture.organizationId, manual, userActor("u_1", "Olive"));

    expect(wrote).toBe(true);
    const suspension = await suspensionOf(fixture.organizationId);
    expect(suspension?.source).toBe("manual");
    expect(suspension?.reason).toBe(manual.reason);

    const rows = await db.select().from(activity).where(eq(activity.organizationId, fixture.organizationId));
    expect(rows.map((row) => row.action)).toEqual(["organization.suspended"]);
    expect(rows[0]?.actorLabel).toBe("Olive");
    expect(rows[0]?.metadata).toMatchObject({ source: "manual", reason: manual.reason });
  });

  it("keeps the first suspension when a second one arrives", async () => {
    await suspendOrganization(fixture.organizationId, manual, userActor("u_1", "Olive"));
    const wrote = await suspendOrganization(
      fixture.organizationId,
      { source: "provider", reason: "AWS paused the provider." },
      workerActor("SES"),
    );

    expect(wrote).toBe(false);
    expect((await suspensionOf(fixture.organizationId))?.source).toBe("manual");
    expect(sendPushAlert).toHaveBeenCalledTimes(1);
  });

});

describe("releaseOrganizationSuspension", () => {
  it("clears the suspension and records who released it", async () => {
    await suspendOrganization(fixture.organizationId, manual, userActor("u_1", "Olive"));
    const released = await releaseOrganizationSuspension(fixture.organizationId, userActor("u_2", "Otto"));

    expect(released).toBe(true);
    expect(await suspensionOf(fixture.organizationId)).toBeNull();
    const rows = await db.select().from(activity).where(eq(activity.action, "organization.suspension.released"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorLabel).toBe("Otto");
  });

  it("is a no-op, with no activity row, when nothing is suspended", async () => {
    expect(await releaseOrganizationSuspension(fixture.organizationId, userActor("u_2", "Otto"))).toBe(false);
    expect(await db.select().from(activity)).toHaveLength(0);
  });
});

describe("POST /v1/emails for a suspended organization", () => {
  it("refuses the send with 403 organization_suspended and says why", async () => {
    await suspendOrganization(fixture.organizationId, manual, userActor("u_1", "Olive"));

    const response = await POST(post(fixture.secret, valid));
    const body = (await response.json()) as { error: { code: string; message: string; detail: Record<string, unknown> } };

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("organization_suspended");
    expect(body.error.message).toContain("suspended");
    expect(body.error.detail).toMatchObject({ source: "manual", reason: manual.reason });
    expect(typeof body.error.detail.suspended_at).toBe("string");
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it("refuses a batch the same way", async () => {
    await suspendOrganization(fixture.organizationId, manual, userActor("u_1", "Olive"));

    const response = await postBatch(
      new Request("http://localhost/v1/batches", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${fixture.secret}` },
        body: JSON.stringify({ ...valid, to: undefined, recipients: [{ address: "person@example.net" }] }),
      }),
    );
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("organization_suspended");
  });

  it("accepts sends again once released", async () => {
    await suspendOrganization(fixture.organizationId, manual, userActor("u_1", "Olive"));
    await releaseOrganizationSuspension(fixture.organizationId, userActor("u_1", "Olive"));

    const response = await POST(post(fixture.secret, valid));
    expect(response.status).toBe(202);
  });

  it("leaves another organization's sends alone", async () => {
    const other = await seedFixture();
    await suspendOrganization(fixture.organizationId, manual, userActor("u_1", "Olive"));

    const response = await POST(post(other.secret, valid));
    expect(response.status).toBe(202);
  });
});

describe("queued messages when an organization is suspended", () => {
  it("fails a queued message with a recorded reason under a manual suspension", async () => {
    const id = await queue();
    const claimed = await claimAll();
    await suspendOrganization(fixture.organizationId, manual, userActor("u_1", "Olive"));

    for (const item of claimed) await deliver(item, "worker-a");

    const row = await messageRow(id);
    expect(row?.status).toBe("failed");
    expect(row?.failureReason).toContain("suspended");
    expect(row?.attempts).toBe(0);
    const events = await db.select().from(messageEvents).where(eq(messageEvents.messageId, id));
    const failed = events.find((event) => event.status === "failed");
    expect(failed?.reason).toContain(manual.reason);
  });

  it("makes queued messages due immediately so the worker fails them promptly", async () => {
    const id = await queue();
    const later = new Date((await dbNow()).getTime() + 60 * 60 * 1000);
    await db.update(messages).set({ nextAttemptAt: later }).where(eq(messages.id, id));

    await suspendOrganization(fixture.organizationId, manual, userActor("u_1", "Olive"));
    for (const item of await claimAll()) await deliver(item, "worker-a");

    expect((await messageRow(id)).status).toBe("failed");
  });

  it("holds, rather than fails, queued messages under a reputation suspension", async () => {
    const id = await queue();
    await suspendOrganization(
      fixture.organizationId,
      { source: "reputation", reason: "Bounce rate is 9.00%, above our 2.50% action point." },
      workerActor("Reputation guard"),
    );

    for (const item of await claimAll()) await deliver(item, "worker-a");
    const held = await messageRow(id);
    expect(held?.status).toBe("queued");
    expect(held?.attempts).toBe(0);
    expect(held?.failureReason).toBeNull();

    await releaseOrganizationSuspension(fixture.organizationId, userActor("u_1", "Olive"));
    await db.update(messages).set({ nextAttemptAt: await dbNow() }).where(eq(messages.id, id));
    for (const item of await claimAll()) await deliver(item, "worker-a");
    expect((await messageRow(id)).status).toBe("sent");
  });
});

describe("queued messages under a provider suspension", () => {
  const paused = { source: "provider" as const, reason: "The email provider paused sending for this organization." };

  it("holds them without spending an attempt, and doesn't make them due", async () => {
    const id = await queue();
    const later = new Date((await dbNow()).getTime() + 60 * 60 * 1000);
    await db.update(messages).set({ nextAttemptAt: later }).where(eq(messages.id, id));

    await suspendOrganization(fixture.organizationId, paused, providerActor("pac_1", "Hosted"));

    expect((await messageRow(id)).nextAttemptAt).toEqual(later);
    await db.update(messages).set({ nextAttemptAt: await dbNow() }).where(eq(messages.id, id));
    for (const item of await claimAll()) await deliver(item, "worker-a");

    const held = await messageRow(id);
    expect(held?.status).toBe("queued");
    expect(held?.attempts).toBe(0);
    expect(held?.failureReason).toBeNull();
  });

  it("reports the hold as provider_paused", async () => {
    const id = await queue();
    await suspendOrganization(fixture.organizationId, paused, providerActor("pac_1", "Hosted"));

    const hold = await messageHold(await messageRow(id));

    expect(hold.domainStall).toBeNull();
    expect(hold.organizationStall).toMatchObject({ reason: "provider_paused", message: paused.reason });
  });

  it("sends them once the provider lifts its suspension", async () => {
    const id = await queue();
    await suspendOrganization(fixture.organizationId, paused, providerActor("pac_1", "Hosted"));
    for (const item of await claimAll()) await deliver(item, "worker-a");
    expect((await messageRow(id)).status).toBe("queued");

    expect(
      await releaseOrganizationSuspension(fixture.organizationId, providerActor("pac_1", "Hosted"), undefined, { onlySource: "provider" }),
    ).toBe(true);
    await db.update(messages).set({ nextAttemptAt: await dbNow() }).where(eq(messages.id, id));
    for (const item of await claimAll()) await deliver(item, "worker-a");

    const sent = await messageRow(id);
    expect(sent?.status).toBe("sent");
    expect(sent?.attempts).toBe(1);
  });

  it("still refuses new sends", async () => {
    await suspendOrganization(fixture.organizationId, paused, providerActor("pac_1", "Hosted"));

    const response = await POST(post(fixture.secret, valid));

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string; detail: { source: string } } };
    expect(body.error.code).toBe("organization_suspended");
    expect(body.error.detail.source).toBe("provider");
  });

  it("reports no hold for a message a manual suspension is about to fail", async () => {
    const id = await queue();
    await suspendOrganization(fixture.organizationId, manual, userActor("u_1", "Olive"));

    expect(await messageHold(await messageRow(id))).toEqual({ domainStall: null, organizationStall: null });
  });
});

describe("the org-level stall", () => {
  it("suspends an organization whose domains each stay under the floor but together cross the action point", async () => {
    // Each domain resolves 9 messages: under the count volume floor, so no domain can stall.
    const domainIds = [fixture.domainId];
    for (let i = 0; i < 5; i++) domainIds.push((await addDomainKey(fixture, `d${i}.example.com`)).domainId);
    for (const domainId of domainIds) {
      await insertOutcomes(domainId, "bounced", 2);
      await insertOutcomes(domainId, "delivered", 7);
    }

    await loop().tick();

    const stalled = await db.select().from(domains).where(eq(domains.organizationId, fixture.organizationId));
    expect(stalled.every((domain) => domain.stalledAt === null)).toBe(true);

    const suspension = await suspensionOf(fixture.organizationId);
    expect(suspension?.source).toBe("reputation");
    expect(suspension?.detail).toMatchObject({ reason: "bounce_rate", count: 12, denominator: 54 });
    expect(sendPushAlert).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Organization suspended: Test" }),
    );
  });

  it("leaves a single-domain organization to the domain stall rather than suspending it too", async () => {
    await insertOutcomes(fixture.domainId, "bounced", 10);
    await insertOutcomes(fixture.domainId, "delivered", 90);

    await loop().tick();

    const [domain] = await db.select().from(domains).where(eq(domains.id, fixture.domainId));
    expect(domain?.stalledAt).not.toBeNull();
    expect(await suspensionOf(fixture.organizationId)).toBeNull();
  });

  it("doesn't count a domain already stalled toward the organization's total", async () => {
    const second = await addDomainKey(fixture, "second.example.com");
    await insertOutcomes(fixture.domainId, "bounced", 10);
    await insertOutcomes(fixture.domainId, "delivered", 90);
    await insertOutcomes(second.domainId, "delivered", 100);
    const [domain] = await db.select().from(domains).where(eq(domains.id, fixture.domainId));
    await stallDomain(
      domain!,
      {
        reason: "bounce_rate",
        detail: { metric: "bounce", count: 10, denominator: 100, rate: 0.1, previousRate: null, threshold: DEFAULT_STALL_LINES.bounce.stall },
      },
      await dbNow(),
    );

    await loop().tick();

    expect(await suspensionOf(fixture.organizationId)).toBeNull();
  });

  it("never releases a suspension on its own once the rate recovers", async () => {
    await suspendOrganization(
      fixture.organizationId,
      { source: "reputation", reason: "Bounce rate is 9.00%, above our 2.50% action point." },
      workerActor("Reputation guard"),
    );
    await insertOutcomes(fixture.domainId, "delivered", 200);

    await loop().tick();

    expect((await suspensionOf(fixture.organizationId))?.source).toBe("reputation");
  });

  it("stays quiet for an organization whose summed rate is healthy", async () => {
    const second = await addDomainKey(fixture, "second.example.com");
    for (const domainId of [fixture.domainId, second.domainId]) {
      await insertOutcomes(domainId, "bounced", 1);
      await insertOutcomes(domainId, "delivered", 99);
    }

    await loop().tick();

    expect(await suspensionOf(fixture.organizationId)).toBeNull();
    const [org] = await db.select().from(organizations).where(eq(organizations.id, fixture.organizationId));
    expect(org?.suspensionCheckedAt).not.toBeNull();
  });
});

describe("the provider-identity rollup", () => {
  async function orgOnIdentity(name: string, identity: string, bounced: number, delivered: number) {
    const organizationId = newId("organization");
    await db.insert(organizations).values({ id: organizationId, name, slug: `slug-${organizationId}` });
    const providerId = newId("provider");
    await db.insert(providers).values({
      id: providerId,
      organizationId,
      adapter: "ses",
      name: "primary",
      credentials: encryptCredentials({}),
      settings: {},
      providerIdentity: identity,
    });
    const domainId = newId("domain");
    await db.insert(domains).values({
      id: domainId,
      organizationId,
      providerId,
      name: `${organizationId}.example.com`,
      status: "pending",
    });
    for (const [status, count] of [["bounced", bounced], ["delivered", delivered]] as const) {
      for (let i = 0; i < count; i++) {
        const messageId = newId("message");
        await db.insert(messages).values({
          id: messageId,
          organizationId,
          domainId,
          status,
          fromAddress: "hi@example.com",
          recipients: ["person@example.net"],
          subject: "Hi",
          envelope: { from: "hi@example.com", fromName: null, to: ["person@example.net"], cc: [], bcc: [], replyTo: [], headers: {}, attachmentCount: 0 },
          tags: [],
        });
        await db.insert(messageEvents).values({
          id: newId("event"),
          organizationId,
          messageId,
          kind: "transition",
          status,
          providerId,
          occurredAt: new Date(),
        });
      }
    }
    return organizationId;
  }

  it("alerts once when organizations sharing one provider identity cross the action point together", async () => {
    await orgOnIdentity("Acme", "111111111111", 2, 38);
    await orgOnIdentity("Globex", "111111111111", 2, 38);

    await loop().tick();
    await loop().tick();

    const rollupAlerts = vi
      .mocked(sendPushAlert)
      .mock.calls.filter(([input]) => input.title.startsWith("Provider at risk"));
    expect(rollupAlerts).toHaveLength(1);
    expect(rollupAlerts[0]?.[0].message).toContain("Acme, Globex");
    expect(rollupAlerts[0]?.[0].message).toContain("5.00%");
  });

  it("takes no action on the organizations themselves", async () => {
    const acme = await orgOnIdentity("Acme", "111111111111", 2, 38);
    const globex = await orgOnIdentity("Globex", "111111111111", 2, 38);

    await loop().tick();

    expect(await suspensionOf(acme)).toBeNull();
    expect(await suspensionOf(globex)).toBeNull();
  });

  it("doesn't alert for one organization alone on an identity", async () => {
    await orgOnIdentity("Acme", "111111111111", 4, 76);

    await loop().tick();

    const titles = vi.mocked(sendPushAlert).mock.calls.map(([input]) => input.title);
    expect(titles.some((title) => title.startsWith("Provider at risk"))).toBe(false);
  });

  it("doesn't merge organizations on different identities", async () => {
    await orgOnIdentity("Acme", "111111111111", 2, 38);
    await orgOnIdentity("Globex", "222222222222", 2, 38);

    await loop().tick();

    const titles = vi.mocked(sendPushAlert).mock.calls.map(([input]) => input.title);
    expect(titles.some((title) => title.startsWith("Provider at risk"))).toBe(false);
  });
});

describe("admin suspend and release actions", () => {
  it("refuses a non-admin, server-side", async () => {
    sessionState.userId = await makeUser(false);

    await expect(
      suspendOrganizationAction({ status: "idle" }, form({ id: fixture.organizationId, reason: "no" })),
    ).rejects.toThrow("Forbidden");
    expect(await suspensionOf(fixture.organizationId)).toBeNull();
  });

  it("suspends and releases as the admin, recorded under their name", async () => {
    sessionState.userId = await makeUser(true);

    const suspended = await suspendOrganizationAction({ status: "idle" }, form({ id: fixture.organizationId, reason: manual.reason }));
    expect(suspended.status).toBe("ok");
    expect((await suspensionOf(fixture.organizationId))?.reason).toBe(manual.reason);

    const released = await releaseOrganizationAction({ status: "idle" }, form({ id: fixture.organizationId }));
    expect(released.status).toBe("ok");
    expect(await suspensionOf(fixture.organizationId)).toBeNull();

    const rows = await db.select().from(activity).where(eq(activity.organizationId, fixture.organizationId));
    expect(rows.map((row) => row.actorLabel)).toEqual(["Olive Admin", "Olive Admin"]);
  });

  it("requires a reason to suspend", async () => {
    sessionState.userId = await makeUser(true);

    const result = await suspendOrganizationAction({ status: "idle" }, form({ id: fixture.organizationId, reason: "  " }));
    expect(result.status).toBe("error");
    expect(await suspensionOf(fixture.organizationId)).toBeNull();
  });

  it("lists organizations with their suspension state for the admin screen", async () => {
    await suspendOrganization(fixture.organizationId, manual, userActor("u_1", "Olive"));
    const other = await seedFixture();

    const { organizations: list } = await listOrganizationsForOperator();
    const suspended = list.find((org) => org.id === fixture.organizationId);
    const healthy = list.find((org) => org.id === other.organizationId);
    expect(suspended?.suspension?.reason).toBe(manual.reason);
    expect(healthy?.suspension).toBeNull();
  });
});
