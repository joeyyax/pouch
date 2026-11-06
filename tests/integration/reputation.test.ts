import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import {
  activity,
  domains,
  memberships,
  messages,
  reputationStates,
  users,
  webhookDeliveries,
  webhookEndpoints,
  type MessageStatus,
  type WebhookEventType,
} from "@/lib/db/schema";
import { encrypt } from "@/lib/crypto";
import { createApiKey } from "@/lib/api/key-lifecycle";
import { newId } from "@/lib/ids";
import type { OrgRole } from "@/lib/auth/permissions";
import { acceptMessage } from "@/lib/messages/create";
import { sendPushAlert } from "@/lib/notifications/push/push";
import { readSignals } from "@/lib/reputation/signals";
import { recordProviderFinding } from "@/lib/reputation/provider-findings";
import { readDomainReputation, readOrganizationReputation } from "@/lib/reputation/read";
import { applyEvent } from "@/lib/messages/events";
import { checkReputation } from "@/lib/reputation/transitions";
import { setStoredSetting } from "@/lib/settings/service";
import { suspendOrganization, releaseOrganizationSuspension } from "@/lib/suspension";
import { workerActor } from "@/lib/activity/record";
import {
  addDomainKey,
  addSuppression,
  eventSource,
  resetDatabase,
  seedFixture,
  seedSystemOrganization,
  systemMailMessages,
  type Fixture,
} from "./fixtures";

vi.mock("@/lib/notifications/push/push", () => ({ sendPushAlert: vi.fn().mockResolvedValue(undefined) }));

const DAY_MS = 24 * 60 * 60 * 1000;

let fixture: Fixture;
let owners: string[];

async function addMember(role: OrgRole): Promise<string> {
  const userId = crypto.randomUUID();
  const email = `${role}-${userId.slice(0, 8)}@owners.example`;
  await db.insert(users).values({ id: userId, organizationId: fixture.organizationId, name: role, email });
  await db.insert(memberships).values({ id: newId("membership"), userId, organizationId: fixture.organizationId, role });
  return email;
}

async function insertMessages(count: number, status: MessageStatus, createdAt: Date, domainId = fixture.domainId, recipient?: (i: number) => string) {
  if (count === 0) return;
  await db.insert(messages).values(
    Array.from({ length: count }, (_, i) => {
      const to = recipient ? recipient(i) : "person@example.net";
      return {
        id: newId("message"),
        organizationId: fixture.organizationId,
        domainId,
        status,
        fromAddress: "hi@example.com",
        recipients: [to],
        subject: "Hello",
        envelope: { from: "hi@example.com", fromName: null, to: [to], cc: [], bcc: [], replyTo: [], headers: {}, attachmentCount: 0 },
        tags: [],
        createdAt,
      };
    }),
  );
}

/** 1,000 resolved messages in each of the last two weeks, with the same bounce count in both. */
async function week(bounced: number, domainId = fixture.domainId) {
  const now = await dbNow();
  await db.delete(messages).where(eq(messages.domainId, domainId));
  await insertMessages(1000 - bounced, "delivered", new Date(now.getTime() - DAY_MS), domainId);
  await insertMessages(bounced, "bounced", new Date(now.getTime() - DAY_MS), domainId);
  await insertMessages(1000 - bounced, "delivered", new Date(now.getTime() - 8 * DAY_MS), domainId);
  await insertMessages(bounced, "bounced", new Date(now.getTime() - 8 * DAY_MS), domainId);
}

async function alertsTo(email: string) {
  return (await systemMailMessages())
    .filter((message) => message.recipients.includes(email))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

async function endpointFor(apiKeyId: string, events: WebhookEventType[]): Promise<string> {
  const id = newId("webhookEndpoint");
  await db.insert(webhookEndpoints).values({
    id,
    organizationId: fixture.organizationId,
    apiKeyId,
    url: "https://receiver.example.net/hook",
    events,
    secretEncrypted: encrypt("secret"),
  });
  return id;
}

async function deliveriesFor(endpointId: string) {
  return db.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, endpointId));
}

async function state(subjectId: string) {
  const [row] = await db.select().from(reputationStates).where(eq(reputationStates.subjectId, subjectId));
  return row;
}

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
  await seedSystemOrganization();
  owners = [await addMember("owner"), await addMember("owner")];
  await addMember("member");
  vi.mocked(sendPushAlert).mockClear();
});

describe("checkReputation", () => {
  it("emails every owner, pushes and posts a webhook when a domain becomes at risk", async () => {
    const endpoint = await endpointFor(fixture.key.id, ["domain.reputation_changed"]);
    await week(22);

    await checkReputation(fixture.organizationId, await dbNow());

    expect((await state(fixture.domainId))?.standing).toBe("at_risk");
    for (const owner of owners) {
      const [mail] = await alertsTo(owner);
      expect(mail?.subject).toBe("At risk of pausing: example.com");
    }
    expect((await alertsTo(owners[0]!))[0]?.envelope.to).toEqual([owners[0]]);
    expect((await systemMailMessages()).some((message) => message.recipients[0]?.startsWith("member-"))).toBe(false);
    expect(sendPushAlert).toHaveBeenCalledWith(expect.objectContaining({ title: "At risk: example.com" }));

    const [delivery] = await deliveriesFor(endpoint);
    expect(delivery?.eventType).toBe("domain.reputation_changed");
    expect(delivery?.payload).toMatchObject({
      type: "domain.reputation_changed",
      data: { standing: "at_risk", previous_standing: "healthy", subject: { type: "domain", id: fixture.domainId } },
    });

    const [logged] = await db
      .select()
      .from(activity)
      .where(and(eq(activity.organizationId, fixture.organizationId), eq(activity.action, "domain.reputation.changed")));
    expect(logged?.metadata).toMatchObject({ from: "healthy", to: "at_risk" });
  });

  it("does nothing when the standing hasn't changed", async () => {
    const endpoint = await endpointFor(fixture.key.id, ["domain.reputation_changed"]);
    await week(22);
    const now = await dbNow();
    await checkReputation(fixture.organizationId, now);
    await checkReputation(fixture.organizationId, new Date(now.getTime() + 60_000));

    expect(await deliveriesFor(endpoint)).toHaveLength(1);
    expect(await alertsTo(owners[0]!)).toHaveLength(1);
  });

  it("posts watch changes but emails nobody", async () => {
    const endpoint = await endpointFor(fixture.key.id, ["domain.reputation_changed"]);
    await week(14);
    await checkReputation(fixture.organizationId, await dbNow());

    expect((await state(fixture.domainId))?.standing).toBe("watch");
    expect(await deliveriesFor(endpoint)).toHaveLength(1);
    expect(await alertsTo(owners[0]!)).toHaveLength(0);
    expect(sendPushAlert).not.toHaveBeenCalled();
  });

  it("throttles re-entering the same standing inside the repeat window", async () => {
    const now = await dbNow();
    await week(22);
    await checkReputation(fixture.organizationId, now);
    await week(14);
    await checkReputation(fixture.organizationId, new Date(now.getTime() + 60_000));
    await week(22);
    await checkReputation(fixture.organizationId, new Date(now.getTime() + 120_000));

    expect((await state(fixture.domainId))?.standing).toBe("at_risk");
    expect(await alertsTo(owners[0]!)).toHaveLength(1);
  });

  it("emails again once the repeat window has passed", async () => {
    const now = await dbNow();
    await week(22);
    await checkReputation(fixture.organizationId, now);
    await week(14);
    await checkReputation(fixture.organizationId, new Date(now.getTime() + 60_000));
    await week(22);
    await checkReputation(fixture.organizationId, new Date(now.getTime() + 24 * 3_600_000 + 60_000));

    expect(await alertsTo(owners[0]!)).toHaveLength(2);
  });

  it("emails again once the repeat window the operator set has passed", async () => {
    await setStoredSetting("standing_alert_repeat_hours", 2);
    const now = await dbNow();
    await week(22);
    await checkReputation(fixture.organizationId, now);
    await week(14);
    await checkReputation(fixture.organizationId, new Date(now.getTime() + 60_000));
    await week(22);
    await checkReputation(fixture.organizationId, new Date(now.getTime() + 2 * 3_600_000 + 60_000));

    expect(await alertsTo(owners[0]!)).toHaveLength(2);
  });

  it("always emails a worse standing, even inside the repeat window", async () => {
    const now = await dbNow();
    await week(22);
    await checkReputation(fixture.organizationId, now);

    await db
      .update(domains)
      .set({ stalledAt: now, stallReason: "bounce_rate", stallDetail: { metric: "bounce", count: 30, denominator: 1000, rate: 0.03, previousRate: 0, threshold: 0.025 } })
      .where(eq(domains.id, fixture.domainId));
    await checkReputation(fixture.organizationId, new Date(now.getTime() + 60_000));

    const mail = await alertsTo(owners[0]!);
    expect(mail.map((message) => message.subject)).toEqual(["At risk of pausing: example.com", "Sending paused: example.com"]);
  });

  it("emails on release, and a pause right after the release emails again", async () => {
    const now = await dbNow();
    await week(0);
    const detail = { metric: "bounce" as const, count: 30, denominator: 1000, rate: 0.03, previousRate: 0, threshold: 0.025 };
    await db.update(domains).set({ stalledAt: now, stallReason: "bounce_rate", stallDetail: detail }).where(eq(domains.id, fixture.domainId));
    await checkReputation(fixture.organizationId, now);

    await db.update(domains).set({ stalledAt: null, stallReason: null, stallDetail: null }).where(eq(domains.id, fixture.domainId));
    await checkReputation(fixture.organizationId, new Date(now.getTime() + 60_000));

    await db.update(domains).set({ stalledAt: now, stallReason: "bounce_rate", stallDetail: detail }).where(eq(domains.id, fixture.domainId));
    await checkReputation(fixture.organizationId, new Date(now.getTime() + 120_000));

    const subjects = (await alertsTo(owners[0]!)).map((message) => message.subject);
    expect(subjects).toEqual(["Sending paused: example.com", "Sending resumed: example.com", "Sending paused: example.com"]);
  });

  it("tells owners when the organization is suspended and released", async () => {
    await week(0);
    const now = await dbNow();
    await suspendOrganization(fixture.organizationId, { source: "manual", reason: "Terms review." }, workerActor("Test"), now);
    await checkReputation(fixture.organizationId, now);
    expect((await state(fixture.organizationId))?.standing).toBe("paused");

    await releaseOrganizationSuspension(fixture.organizationId, workerActor("Test"));
    await checkReputation(fixture.organizationId, new Date(now.getTime() + 60_000));

    const subjects = (await alertsTo(owners[0]!)).map((message) => message.subject);
    expect(subjects).toEqual(["Sending paused: Test", "Sending resumed: Test"]);
  });

  it("sends organization changes only to keys that reach every domain", async () => {
    const second = await addDomainKey(fixture);
    const unscoped = await createApiKey({ organizationId: fixture.organizationId, name: "all", mode: "live", domainIds: [] });
    const scopedEndpoint = await endpointFor(fixture.key.id, ["organization.reputation_changed"]);
    const unscopedEndpoint = await endpointFor(unscoped.key.id, ["organization.reputation_changed"]);

    // Each domain is under the rate floor; together they're within reach of the stall line.
    const now = await dbNow();
    for (const domainId of [fixture.domainId, second.domainId]) {
      await insertMessages(44, "delivered", new Date(now.getTime() - DAY_MS), domainId);
      await insertMessages(1, "bounced", new Date(now.getTime() - DAY_MS), domainId);
    }
    await checkReputation(fixture.organizationId, now);

    expect((await state(fixture.organizationId))?.standing).toBe("at_risk");
    expect(await deliveriesFor(scopedEndpoint)).toHaveLength(0);
    expect(await deliveriesFor(unscopedEndpoint)).toHaveLength(1);
  });
});

describe("provider findings", () => {
  it("email owners when a high-impact finding opens and clear when it closes", async () => {
    const finding = {
      organizationId: fixture.organizationId,
      providerId: fixture.providerId,
      type: "BOUNCE",
      impact: "HIGH",
      description: "The bounce rate exceeded 15.0%.",
    };
    const now = await dbNow();
    await recordProviderFinding({ ...finding, kind: "finding_opened" });
    await checkReputation(fixture.organizationId, now);

    expect((await state(fixture.organizationId))?.standing).toBe("at_risk");
    expect((await alertsTo(owners[0]!)).map((message) => message.subject)).toEqual(["At risk of pausing: Test"]);
    const [domain] = await db.select().from(domains).where(eq(domains.id, fixture.domainId));
    expect(domain?.stalledAt).toBeNull();

    await recordProviderFinding({ ...finding, kind: "finding_closed" });
    await checkReputation(fixture.organizationId, new Date(now.getTime() + 60_000));
    expect((await state(fixture.organizationId))?.standing).toBe("healthy");
    expect(await alertsTo(owners[0]!)).toHaveLength(1);
  });

  it("put the organization on watch for a finding that isn't high impact", async () => {
    await recordProviderFinding({
      organizationId: fixture.organizationId,
      providerId: fixture.providerId,
      kind: "finding_opened",
      type: "COMPLAINT",
      impact: "LOW",
      description: null,
    });
    await checkReputation(fixture.organizationId, await dbNow());
    expect((await state(fixture.organizationId))?.standing).toBe("watch");
    expect(await alertsTo(owners[0]!)).toHaveLength(0);
  });
});

describe("behavior signals", () => {
  it("count sends refused because a recipient is suppressed", async () => {
    await addSuppression(fixture.organizationId, "gone@example.net");
    for (let i = 0; i < 3; i += 1) {
      await expect(
        acceptMessage(fixture.key, { from: "hi@example.com", to: ["gone@example.net"], subject: "Hi", text: "Hi" }, null),
      ).rejects.toMatchObject({ code: "recipient_suppressed" });
    }
    const signals = await readSignals(fixture.organizationId, await dbNow());
    expect(signals.get(fixture.domainId)?.suppressedRejections).toBe(3);
  });

  it("count first-time recipients against the organization's history", async () => {
    await acceptMessage(fixture.key, { from: "hi@example.com", to: ["new@example.net"], subject: "Hi", text: "Hi" }, null);
    const now = await dbNow();
    await insertMessages(1, "delivered", new Date(now.getTime() - 1000), fixture.domainId, () => "old@example.net");
    await db.execute(
      sql`insert into recipient_history (organization_id, address, first_seen_at) values (${fixture.organizationId}, 'old@example.net', now() - interval '30 days')`,
    );

    const signals = await readSignals(fixture.organizationId, await dbNow());
    expect(signals.get(fixture.domainId)).toMatchObject({ recentRecipients: 2, firstTimeRecipients: 1 });
  });

  it("raise a domain on a volume spike without pausing it", async () => {
    const now = await dbNow();
    await insertMessages(70, "delivered", new Date(now.getTime() - 3 * DAY_MS));
    await insertMessages(600, "delivered", new Date(now.getTime() - 60_000), fixture.domainId, (i) => `person${i}@example.net`);

    const reputation = await readOrganizationReputation(fixture.organizationId, now);
    expect(reputation.domains.get(fixture.domainId)?.standing).toBe("at_risk");
    expect(reputation.domains.get(fixture.domainId)?.findings[0]?.kind).toBe("volume_spike");

    await checkReputation(fixture.organizationId, now);
    const [domain] = await db.select().from(domains).where(eq(domains.id, fixture.domainId));
    expect(domain?.stalledAt).toBeNull();
  });
});

describe("recent reasons", () => {
  async function bounce(providerMessageId: string, reason: string, bounceType?: string) {
    const now = await dbNow();
    await db.insert(messages).values({
      id: newId("message"),
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      providerId: fixture.providerId,
      providerMessageId,
      status: "sent",
      fromAddress: "hi@example.com",
      recipients: ["person@example.net"],
      subject: "Hello",
      envelope: { from: "hi@example.com", fromName: null, to: ["person@example.net"], cc: [], bcc: [], replyTo: [], headers: {}, attachmentCount: 0 },
      tags: [],
      createdAt: now,
    });
    await applyEvent(eventSource(fixture), {
      providerMessageId,
      providerEventId: `event-${providerMessageId}`,
      status: "bounced",
      reason,
      bounceType,
      occurredAt: now,
      detail: {},
      recipients: ["person@example.net"],
    });
  }

  it("carry the bounce subtype in plain words beside the provider's reason", async () => {
    await bounce("ses-1", "smtp; 550 5.1.1 user unknown", "Permanent/NoEmail");
    await bounce("ses-2", "smtp; 550 5.1.1 user unknown", "Permanent/NoEmail");
    await bounce("mailpace-1", "Mailbox does not exist");

    const reputation = await readDomainReputation(fixture.organizationId, fixture.domainId, await dbNow());
    expect(reputation?.reasons.map(({ reason, kind, count }) => ({ reason, kind, count }))).toEqual(
      expect.arrayContaining([
        { reason: "smtp; 550 5.1.1 user unknown", kind: "Mailbox doesn't exist", count: 2 },
        { reason: "Mailbox does not exist", kind: null, count: 1 },
      ]),
    );
    expect(reputation?.reasons).toHaveLength(2);
  });
});
