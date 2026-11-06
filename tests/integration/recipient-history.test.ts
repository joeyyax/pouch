import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages, recipientHistory } from "@/lib/db/schema";
import { acceptMessage } from "@/lib/messages/create";
import { applyEvent } from "@/lib/messages/events";
import { historyFor, warningsFor } from "@/lib/messages/history";
import { unsuppress } from "@/lib/messages/suppression";
import { newId } from "@/lib/ids";
import type { NormalizedEvent } from "@/lib/providers/adapters/types";
import { eventSource, resetDatabase, seedFixture, type Fixture } from "./fixtures";

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    providerMessageId: "provider-1",
    providerEventId: "event-1",
    status: "bounced",
    reason: "mailbox does not exist",
    occurredAt: new Date(),
    detail: {},
    recipients: [],
    ...overrides,
  };
}

/**
 * A message already handed to the provider, inserted directly rather than through
 * `acceptMessage` — a repeat bounce would otherwise suppress the address after the first one
 * and block every send after it, which is exactly the case these tests need to get past to
 * reach the rollup's own counting.
 */
async function sentMessage(fixture: Fixture, to: string, providerMessageId: string): Promise<string> {
  const id = newId("message");
  await db.insert(messages).values({
    id,
    organizationId: fixture.organizationId,
    domainId: fixture.domainId,
    fromAddress: "ada@example.com",
    recipients: [to],
    subject: "Hello",
    envelope: { from: "ada@example.com", fromName: "Ada", to: [to], cc: [], bcc: [], replyTo: [], headers: {}, attachmentCount: 0 },
    status: "sent",
    providerId: fixture.providerId,
    providerMessageId,
    sentAt: new Date(),
  });
  return id;
}

/**
 * Bounces one address `count` times, each a distinct provider event, then removes the
 * suppression a bounce earns — the "suppressed once and manually removed" case from #46,
 * which is what lets a caller reach the warning at all instead of `recipient_suppressed`.
 */
async function bounce(fixture: Fixture, to: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const providerMessageId = `provider-${to}-${i}`;
    await sentMessage(fixture, to, providerMessageId);
    await applyEvent(
      eventSource(fixture),
      event({ providerMessageId, providerEventId: `event-${to}-${i}`, recipients: [to] }),
    );
  }
  await unsuppress(fixture.organizationId, to);
}

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

describe("the rollup's arithmetic", () => {
  it("counts a bounce once per distinct provider event", async () => {
    await bounce(fixture, "trouble@example.net", 2);

    const [row] = await historyFor(fixture.organizationId, ["trouble@example.net"]);
    expect(row?.bounceCount).toBe(2);
    expect(row?.lastBouncedAt).toBeInstanceOf(Date);
  });

  it("ignores a retried webhook rather than double-counting it", async () => {
    const to = "retry@example.net";
    await sentMessage(fixture, to, "provider-retry");
    const duplicate = event({ providerMessageId: "provider-retry", providerEventId: "event-retry", recipients: [to] });

    await applyEvent(eventSource(fixture), duplicate);
    const second = await applyEvent(eventSource(fixture), duplicate);

    expect(second.outcome).toBe("duplicate");
    const [row] = await historyFor(fixture.organizationId, [to]);
    expect(row?.bounceCount).toBe(1);
  });

  it("records first_seen_at at accept time, before any event arrives", async () => {
    await acceptMessage(
      fixture.key,
      { from: "ada@example.com", to: ["new@example.net"], subject: "Hi", html: "<p>Hi</p>" },
      null,
    );

    const [row] = await db
      .select()
      .from(recipientHistory)
      .where(and(eq(recipientHistory.organizationId, fixture.organizationId), eq(recipientHistory.address, "new@example.net")));
    expect(row?.firstSeenAt).toBeInstanceOf(Date);
    expect(row?.bounceCount).toBe(0);
  });

  it("clears once a later delivery supersedes the bounce run", async () => {
    const to = "recovers@example.net";
    await bounce(fixture, to, 1);

    await sentMessage(fixture, to, "provider-recovers-delivered");
    await applyEvent(
      eventSource(fixture),
      event({
        status: "delivered",
        reason: null,
        providerMessageId: "provider-recovers-delivered",
        providerEventId: "event-recovers-delivered",
        recipients: [to],
      }),
    );

    expect(await warningsFor(fixture.organizationId, [to])).toEqual([]);
  });
});

/**
 * The deferral count bounds to deferrals since the last delivery, not a lifetime total — see
 * lib/messages/history.ts. Greylisting defers a first attempt from many recipients, so a
 * lifetime count reaches the warning threshold on an address that has delivered every message
 * it was ever sent, as long as a retry is still in flight when the next send goes out.
 */
describe("frequent_deferrals bounds to deferrals since the last delivery", () => {
  it("resets the count on delivery instead of accumulating across sends", async () => {
    const to = "greylisted@example.net";
    // Three ordinary messages, each deferred once by greylisting and delivered on retry.
    for (let i = 0; i < 3; i++) {
      const providerMessageId = `provider-${to}-${i}`;
      await sentMessage(fixture, to, providerMessageId);
      await applyEvent(
        eventSource(fixture),
        event({ status: "deferred", reason: "greylisted", providerMessageId, providerEventId: `deferred-${to}-${i}`, recipients: [to] }),
      );
      await applyEvent(
        eventSource(fixture),
        event({ status: "delivered", reason: null, providerMessageId, providerEventId: `delivered-${to}-${i}`, recipients: [to] }),
      );
    }

    const [row] = await historyFor(fixture.organizationId, [to]);
    expect(row?.deferredCount).toBe(0);
    expect(await warningsFor(fixture.organizationId, [to])).toEqual([]);
  });

  it("stays quiet with a second send still deferred while the first is in flight", async () => {
    const to = "interleaved@example.net";

    // Message 1: password reset. Deferred, then finally delivered.
    await sentMessage(fixture, to, "provider-1");
    await applyEvent(
      eventSource(fixture),
      event({ status: "deferred", reason: "greylisted", providerMessageId: "provider-1", providerEventId: "deferred-1", recipients: [to] }),
    );
    await applyEvent(
      eventSource(fixture),
      event({ status: "delivered", reason: null, providerMessageId: "provider-1", providerEventId: "delivered-1", recipients: [to] }),
    );

    // Messages 2 and 3: a receipt sent minutes later, and another, each deferred but not yet
    // delivered — still in flight when the count is checked.
    await sentMessage(fixture, to, "provider-2");
    await applyEvent(
      eventSource(fixture),
      event({ status: "deferred", reason: "greylisted", providerMessageId: "provider-2", providerEventId: "deferred-2", recipients: [to] }),
    );
    await sentMessage(fixture, to, "provider-3");
    await applyEvent(
      eventSource(fixture),
      event({ status: "deferred", reason: "greylisted", providerMessageId: "provider-3", providerEventId: "deferred-3", recipients: [to] }),
    );

    const [row] = await historyFor(fixture.organizationId, [to]);
    expect(row?.deferredCount).toBe(2);
    expect(await warningsFor(fixture.organizationId, [to])).toEqual([]);
  });

  it("still warns when deferrals pile up with nothing delivered since", async () => {
    const to = "stuck@example.net";
    for (let i = 0; i < 3; i++) {
      const providerMessageId = `provider-${to}-${i}`;
      await sentMessage(fixture, to, providerMessageId);
      await applyEvent(
        eventSource(fixture),
        event({ status: "deferred", reason: "greylisted", providerMessageId, providerEventId: `deferred-${to}-${i}`, recipients: [to] }),
      );
    }

    const [row] = await historyFor(fixture.organizationId, [to]);
    expect(row?.deferredCount).toBe(3);
    const warnings = await warningsFor(fixture.organizationId, [to]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: "frequent_deferrals", address: to });
  });
});

describe("a warning never blocks a send", () => {
  it("still returns 202 with the address accepted, and carries the warning", async () => {
    const to = "trouble@example.net";
    await bounce(fixture, to, 1);

    const { message } = await acceptMessage(
      fixture.key,
      { from: "ada@example.com", to: [to], subject: "One more try", html: "<p>Hi</p>" },
      null,
    );

    expect(message.status).toBe("queued");
    expect(message.warnings).toHaveLength(1);
    expect(message.warnings[0]).toMatchObject({ code: "previously_bounced", address: to });
  });

  it("carries no warning for an address with a clean history", async () => {
    const { message } = await acceptMessage(
      fixture.key,
      { from: "ada@example.com", to: ["clean@example.net"], subject: "Hi", html: "<p>Hi</p>" },
      null,
    );
    expect(message.warnings).toEqual([]);
  });
});

describe("organization isolation", () => {
  it("one organization's bounce history never appears in another's warnings", async () => {
    const bad = "shared-looking@example.net";
    await bounce(fixture, bad, 1);

    const other = await seedFixture();
    const { message } = await acceptMessage(
      other.key,
      { from: "ada@example.com", to: [bad], subject: "Hi", html: "<p>Hi</p>" },
      null,
    );

    expect(message.warnings).toEqual([]);
    expect(await warningsFor(other.organizationId, [bad])).toEqual([]);
  });
});
