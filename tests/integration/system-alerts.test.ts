import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { domains, messages, webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import { createApiKey, revokeApiKey } from "@/lib/api/key-lifecycle";
import { createEndpoint } from "@/lib/webhooks/endpoints";
import { claimDeliveries } from "@/lib/webhooks/queue";
import { CONSECUTIVE_EXHAUSTED_LIMIT, deliverWebhook } from "@/worker/webhooks";
import { VerifyLoop } from "@/worker/verify";
import { DEFAULT_SYSTEM_FROM_ADDRESS, sendSystemAlert } from "@/lib/mail/system";
import { SystemMail } from "@/lib/mail/template";
import { setSystemAlertsTo } from "@/lib/settings/service";
import { sendWebhookDisabledAlert } from "@/lib/mail/alerts/webhook-disabled";
import { sendDomainVerificationFailedAlert } from "@/lib/mail/alerts/domain-verification-failed";
import { sendKeyCreatedAlert } from "@/lib/mail/alerts/key-created";
import { sendKeyRevokedAlert } from "@/lib/mail/alerts/key-revoked";
import { BULK_FANOUT_THRESHOLD, checkFanout } from "@/lib/messages/bulk-detect";
import { disableSystemMail, resetDatabase, seedFixture, seedSystemOrganization, systemMailMessages, type Fixture } from "./fixtures";

const alertEmail = (reason: string) => createElement(SystemMail, { heading: "Heading", paragraphs: ["Body."], reason });

/** What the next dns lookup does. Registration always needs a public answer; delivery is private, to exhaust immediately. */
let lookupResult: "public" | "private" = "public";

/** What the mocked provider's domain.verify answers, for the VerifyLoop tests below. */
let domainVerifyAnswer: "verified" | "failed" = "verified";

vi.mock("@/lib/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers")>();
  return {
    ...actual,
    adapterFor: (provider: Parameters<typeof actual.adapterFor>[0]) => {
      const base = actual.adapterFor(provider);
      return {
        ...base,
        domain: {
          ...base.domain,
          verify: async () =>
            domainVerifyAnswer === "verified"
              ? { answered: true, verified: true, missing: [], errors: [] }
              : { answered: true, verified: false, missing: [], errors: ["DKIM verification is FAILED. Recreate the domain."] },
        },
      };
    },
  };
});

vi.mock("node:dns/promises", () => ({
  lookup: () => {
    const address = lookupResult === "private" ? "10.0.0.7" : "203.0.113.9";
    return Promise.resolve([{ address, family: 4 }]);
  },
}));

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
  lookupResult = "public";
  domainVerifyAnswer = "verified";
});

describe("sendSystemAlert", () => {
  it("throws naming the setting when the address doesn't resolve", async () => {
    await disableSystemMail();

    await expect(sendSystemAlert({ subject: "Test", email: alertEmail, idempotencyKey: "k-1" })).rejects.toThrow(
      /system from address/,
    );
  });

  it("sends from the address's domain, as the service's own mail", async () => {
    const system = await seedSystemOrganization();

    await sendSystemAlert({ subject: "Domain check", email: alertEmail, idempotencyKey: "k-domain" });

    expect(await db.select().from(messages).where(eq(messages.organizationId, fixture.organizationId))).toHaveLength(0);
    expect(await db.select().from(messages).where(eq(messages.organizationId, system.organizationId))).toHaveLength(0);

    const serviceMessages = await systemMailMessages();
    expect(serviceMessages).toHaveLength(1);
    expect(serviceMessages[0]!.fromAddress).toBe(DEFAULT_SYSTEM_FROM_ADDRESS);
    expect(serviceMessages[0]!.domainId).toBe(system.domainId);
  });

  it("sends to itself when no alert recipients are set", async () => {
    await seedSystemOrganization();

    await sendSystemAlert({ subject: "Default to", email: alertEmail, idempotencyKey: "k-default-to" });

    const [message] = await db.select().from(messages).where(eq(messages.subject, "Default to"));
    expect(message!.recipients).toEqual([DEFAULT_SYSTEM_FROM_ADDRESS]);
  });

  it("sends one message to each configured recipient, still from the system address and still with List-Unsubscribe", async () => {
    await seedSystemOrganization();
    await setSystemAlertsTo(["joey@example.net", "ops@example.net"]);

    await sendSystemAlert({ subject: "Routed", email: alertEmail, idempotencyKey: "k-routed" });
    await sendSystemAlert({ subject: "Routed", email: alertEmail, idempotencyKey: "k-routed" });

    const rows = await db.select().from(messages).where(eq(messages.subject, "Routed"));
    expect(rows.map((row) => row.recipients).sort()).toEqual([["joey@example.net"], ["ops@example.net"]]);
    for (const row of rows) {
      expect(row.fromAddress).toBe(DEFAULT_SYSTEM_FROM_ADDRESS);
      expect(row.envelope.headers["List-Unsubscribe"]).toBe(`<mailto:${DEFAULT_SYSTEM_FROM_ADDRESS}>`);
    }
  });

  it("falls back to the from address once the recipients are cleared", async () => {
    await seedSystemOrganization();
    await setSystemAlertsTo(["joey@example.net"]);
    await setSystemAlertsTo([]);

    await sendSystemAlert({ subject: "Cleared", email: alertEmail, idempotencyKey: "k-cleared" });

    const [message] = await db.select().from(messages).where(eq(messages.subject, "Cleared"));
    expect(message!.recipients).toEqual([DEFAULT_SYSTEM_FROM_ADDRESS]);
  });

  it("sends once for one idempotency key, no matter how many times it's called", async () => {
    await seedSystemOrganization();

    await sendSystemAlert({ subject: "Repeat check", email: alertEmail, idempotencyKey: "same-key" });
    await sendSystemAlert({ subject: "Repeat check", email: alertEmail, idempotencyKey: "same-key" });
    await sendSystemAlert({ subject: "Repeat check", email: alertEmail, idempotencyKey: "same-key" });

    const rows = await db.select().from(messages).where(eq(messages.subject, "Repeat check"));
    expect(rows).toHaveLength(1);
  });
});

/** Queues one pending delivery against an endpoint, ready to claim. */
async function queueFor(endpointId: string): Promise<void> {
  const now = await dbNow();
  await db.insert(webhookDeliveries).values({
    id: `whd_${Math.random().toString(36).slice(2, 12)}`,
    organizationId: fixture.organizationId,
    endpointId,
    messageId: null,
    eventType: "email.delivered",
    payload: { id: "evt_1", type: "email.delivered", created_at: new Date().toISOString(), data: {} },
    status: "pending",
    attempts: 0,
    nextAttemptAt: now,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
  });
}

describe("a webhook endpoint that disables itself", () => {
  it("sends exactly one alert through the system organization's own send path", async () => {
    await seedSystemOrganization();

    const { endpoint } = await createEndpoint({
      organizationId: fixture.organizationId,
      apiKeyId: fixture.key.id,
      url: "https://receiver.example.net/hook",
      events: ["email.delivered"],
    });
    for (let i = 0; i < CONSECUTIVE_EXHAUSTED_LIMIT; i += 1) await queueFor(endpoint.id);
    lookupResult = "private";

    for (let i = 0; i < CONSECUTIVE_EXHAUSTED_LIMIT; i += 1) {
      const claimed = await claimDeliveries("worker-test", 1);
      expect(claimed).toHaveLength(1);
      await deliverWebhook(claimed[0]!);
    }

    const [row] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpoint.id));
    expect(row!.disabledAt).not.toBeNull();

    const alerts = await systemMailMessages();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.subject).toContain(endpoint.url);

    // A worker restarting mid-run replays the trigger for the same state change.
    await sendWebhookDisabledAlert(row!, CONSECUTIVE_EXHAUSTED_LIMIT);
    expect(await systemMailMessages()).toHaveLength(1);
  });

  it("still disables the endpoint when system mail has nowhere to send from, alert or not", async () => {
    // Proves a missing alert configuration can't block the disable it's supposed to report on.
    await disableSystemMail();
    const { endpoint } = await createEndpoint({
      organizationId: fixture.organizationId,
      apiKeyId: fixture.key.id,
      url: "https://receiver.example.net/hook",
      events: ["email.delivered"],
    });
    for (let i = 0; i < CONSECUTIVE_EXHAUSTED_LIMIT; i += 1) await queueFor(endpoint.id);
    lookupResult = "private";

    for (let i = 0; i < CONSECUTIVE_EXHAUSTED_LIMIT; i += 1) {
      const claimed = await claimDeliveries("worker-test", 1);
      await deliverWebhook(claimed[0]!);
    }

    const [row] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpoint.id));
    expect(row!.disabledAt).not.toBeNull();
  });
});

async function domainRow(id: string) {
  const [found] = await db.select().from(domains).where(eq(domains.id, id));
  if (!found) throw new Error(`domain ${id} disappeared`);
  return found;
}

/** A verified domain only comes due once it's actually been checked before — the real flow
 * stamps lastCheckedAt the moment it verifies, so this simulates that having happened a while ago. */
async function agedVerifiedDomain(id: string): Promise<void> {
  await db.update(domains).set({ lastCheckedAt: new Date(Date.now() - 1000) }).where(eq(domains.id, id));
}

function verifiedLoop(): VerifyLoop {
  return new VerifyLoop({ intervalMs: 60_000, batchSize: 10, recheckAfterMs: 0, verifiedRecheckAfterMs: 0 });
}

describe("a domain that was verified fails verification", () => {
  it("sends exactly one alert through the verify loop", async () => {
    await seedSystemOrganization();
    await agedVerifiedDomain(fixture.domainId);
    domainVerifyAnswer = "failed";
    const verified = await domainRow(fixture.domainId);

    const checked = await verifiedLoop().tick();

    expect(checked).toBe(1);
    expect((await domainRow(fixture.domainId)).status).toBe("failed");

    const alerts = await systemMailMessages();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.subject).toContain("example.com");

    // A worker restarting before it persists the status replays the trigger for the same verified period.
    await sendDomainVerificationFailedAlert(verified, ["DKIM verification is FAILED. Recreate the domain."]);
    expect(await systemMailMessages()).toHaveLength(1);
  });

  it("still flips the domain to failed when system mail has nowhere to send from", async () => {
    await disableSystemMail();
    await agedVerifiedDomain(fixture.domainId);
    domainVerifyAnswer = "failed";

    const checked = await verifiedLoop().tick();

    expect(checked).toBe(1);
    expect((await domainRow(fixture.domainId)).status).toBe("failed");
  });
});

describe("createApiKey sends sendKeyCreatedAlert", () => {
  it("fires exactly one alert when a key is minted", async () => {
    await seedSystemOrganization();

    const minted = await createApiKey({ organizationId: fixture.organizationId, name: "second", mode: "live", domainIds: [] });

    const alerts = await systemMailMessages();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.subject).toContain("second");

    await sendKeyCreatedAlert(minted.key);
    expect(await systemMailMessages()).toHaveLength(1);
  });

  it("still creates the key when system mail has nowhere to send from", async () => {
    await disableSystemMail();
    const minted = await createApiKey({ organizationId: fixture.organizationId, name: "unconfigured", mode: "live", domainIds: [] });
    expect(minted.key.id).toBeTruthy();
  });
});

describe("revokeApiKey sends sendKeyRevokedAlert", () => {
  it("fires exactly one alert when a key is revoked", async () => {
    await seedSystemOrganization();
    const minted = await createApiKey({ organizationId: fixture.organizationId, name: "third", mode: "live", domainIds: [] });

    const revoked = await revokeApiKey(fixture.organizationId, minted.key.id);

    const alerts = (await systemMailMessages()).filter((message) => message.subject.startsWith("Key revoked"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.subject).toContain("third");
    expect(revoked!.revokedAt).not.toBeNull();

    await sendKeyRevokedAlert(revoked!);
    expect((await systemMailMessages()).filter((message) => message.subject.startsWith("Key revoked"))).toHaveLength(1);
  });

  it("still revokes the key when system mail has nowhere to send from", async () => {
    await disableSystemMail();
    const minted = await createApiKey({ organizationId: fixture.organizationId, name: "fourth", mode: "live", domainIds: [] });
    const revoked = await revokeApiKey(fixture.organizationId, minted.key.id);
    expect(revoked!.revokedAt).not.toBeNull();
  });
});

describe("a body hash that fans out past the bulk threshold", () => {
  const headers = { "list-unsubscribe": "<mailto:unsub@example.com>" };

  let nextRecipient = 0;

  /** Always distinct addresses across calls, so each one adds genuinely new recipients to the ledger. */
  async function sendTo(count: number): Promise<void> {
    const recipients = Array.from({ length: count }, () => `person-${nextRecipient++}@example.net`);
    await checkFanout({
      organizationId: fixture.organizationId,
      apiKeyId: fixture.key.id,
      bodyHash: "hash-under-test",
      recipients,
      headers,
      providerCarriesHeaders: true,
    });
  }

  it("sends exactly one alert on the call that crosses the threshold", async () => {
    await seedSystemOrganization();

    await sendTo(BULK_FANOUT_THRESHOLD);
    expect(await systemMailMessages()).toHaveLength(0);

    // One call, one new distinct recipient, crossing the threshold.
    await sendTo(1);
    const alerts = await systemMailMessages();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.subject).toContain(String(BULK_FANOUT_THRESHOLD));

    // Already past it — no second alert.
    await sendTo(1);
    expect(await systemMailMessages()).toHaveLength(1);
  });

  it("still throws list_unsubscribe_required when system mail has nowhere to send from", async () => {
    await disableSystemMail();
    await sendTo(BULK_FANOUT_THRESHOLD);
    await expect(
      checkFanout({
        organizationId: fixture.organizationId,
        apiKeyId: fixture.key.id,
        bodyHash: "hash-under-test",
        recipients: ["one-more@example.net"],
        headers: {},
        providerCarriesHeaders: true,
      }),
    ).rejects.toThrow();
  });
});
