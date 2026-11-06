import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { messageEvents, messages, suppressions } from "@/lib/db/schema";
import { acceptMessage } from "@/lib/messages/create";
import { applyEvent, recordEvent, recordOccurrence } from "@/lib/messages/events";
import { historyFor } from "@/lib/messages/history";
import { buildAdapter } from "@/lib/providers/adapters";
import type { NormalizedEvent } from "@/lib/providers/adapters/types";
import {
  addDomainKeyFor,
  addProvider,
  addSuppression,
  eventSource,
  resetDatabase,
  seedFixture,
  type Fixture,
} from "./fixtures";

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    providerMessageId: "provider-1",
    providerEventId: "event-1",
    status: "delivered",
    reason: null,
    occurredAt: new Date(),
    detail: {},
    recipients: [],
    ...overrides,
  };
}

/** A message already handed to the provider, which is when events start arriving. */
async function sentMessage(fixture: Fixture, to = "person@example.net"): Promise<string> {
  return sentMessageTo(fixture, [to]);
}

/** A message with more than one recipient, already handed to the provider. */
async function sentMessageTo(fixture: Fixture, to: string[]): Promise<string> {
  const { message } = await acceptMessage(
    fixture.key,
    { from: "Ada <ada@example.com>", to, subject: "Hello", html: "<p>Hi</p>" },
    null,
  );
  await db
    .update(messages)
    .set({ status: "sent", providerId: fixture.providerId, providerMessageId: "provider-1", sentAt: new Date() })
    .where(eq(messages.id, message.id));
  return message.id;
}

async function eventRows(messageId: string) {
  return db.select().from(messageEvents).where(eq(messageEvents.messageId, messageId));
}

async function statusOf(messageId: string): Promise<string> {
  const [row] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!row) throw new Error(`message ${messageId} disappeared`);
  return row.status;
}

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

describe("the event clock", () => {
  it("stamps an event from the database, not the app", async () => {
    const id = await sentMessage(fixture);

    // Inside one transaction every now() is the same instant, so an event written there carries
    // the transaction's timestamp exactly. A Date from the app never lands on it.
    const [written, clock] = await db.transaction(async (tx) => {
      // Long enough that the app's clock has moved on from the transaction's frozen now().
      await new Promise((resolve) => setTimeout(resolve, 50));
      const eventId = await recordOccurrence(
        { organizationId: fixture.organizationId, messageId: id, kind: "retry", detail: { attempt: 1, nextAttemptAt: new Date().toISOString() } },
        tx,
      );
      const [row] = await tx.select().from(messageEvents).where(eq(messageEvents.id, eventId));
      return [row?.occurredAt ?? null, await dbNow(tx)];
    });

    expect(written).not.toBeNull();
    expect(written?.getTime()).toBe(clock.getTime());
  });
});

describe("applyEvent", () => {
  it("moves the message to delivered and records the transition", async () => {
    const id = await sentMessage(fixture);

    const result = await applyEvent(eventSource(fixture), event());

    expect(result.outcome).toBe("recorded");
    expect(result.messageId).toBe(id);
    expect(await statusOf(id)).toBe("delivered");
    expect((await eventRows(id)).filter((row) => row.status === "delivered")).toHaveLength(1);
  });

  it("applies a retried webhook once", async () => {
    const id = await sentMessage(fixture);

    await applyEvent(eventSource(fixture), event());
    const second = await applyEvent(eventSource(fixture), event());

    expect(second.outcome).toBe("duplicate");
    expect((await eventRows(id)).filter((row) => row.status === "delivered")).toHaveLength(1);
  });

  it("ignores an event for a provider id it doesn't know", async () => {
    const id = await sentMessage(fixture);
    const before = (await eventRows(id)).length;

    const result = await applyEvent(eventSource(fixture), event({ providerMessageId: "nobody" }));

    expect(result.outcome).toBe("unknown_message");
    expect(await eventRows(id)).toHaveLength(before);
  });

  it("records an out-of-order event without moving the status backwards", async () => {
    const id = await sentMessage(fixture);
    await applyEvent(eventSource(fixture), event({ status: "bounced", reason: "Mailbox does not exist" }));

    const late = await applyEvent(eventSource(fixture), event({ providerEventId: "event-2", status: "delivered" }));

    expect(late.outcome).toBe("recorded");
    expect(late.statusChanged).toBe(false);
    expect(await statusOf(id)).toBe("bounced");
    expect((await eventRows(id)).filter((row) => row.status === "delivered")).toHaveLength(1);
  });

  it("takes a second sent event without throwing", async () => {
    const id = await sentMessage(fixture);

    const result = await applyEvent(eventSource(fixture), event({ status: "sent" }));

    expect(result.outcome).toBe("recorded");
    expect(await statusOf(id)).toBe("sent");
  });

  it("suppresses the recipient on a hard bounce, with the provider's reason verbatim", async () => {
    await sentMessage(fixture, "gone@example.net");

    await applyEvent(
      eventSource(fixture),
      event({ status: "bounced", reason: "smtp; 550 5.1.1 user unknown", recipients: ["gone@example.net"] }),
    );

    const [row] = await db
      .select()
      .from(suppressions)
      .where(and(eq(suppressions.organizationId, fixture.organizationId), eq(suppressions.address, "gone@example.net")));
    expect(row?.reason).toBe("hard_bounce");
    expect(row?.detail).toBe("smtp; 550 5.1.1 user unknown");
  });

  it("suppresses the recipient on a complaint", async () => {
    await sentMessage(fixture, "angry@example.net");

    await applyEvent(eventSource(fixture), event({ status: "complained", reason: "abuse", recipients: ["angry@example.net"] }));

    const [row] = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.address, "angry@example.net"));
    expect(row?.reason).toBe("complaint");
  });

  it("shows the suppression on the message that caused it", async () => {
    const id = await sentMessage(fixture, "gone@example.net");

    await applyEvent(eventSource(fixture), event({ status: "bounced", reason: "550 user unknown", recipients: ["gone@example.net"] }));

    const [suppressed] = (await eventRows(id)).filter((row) => row.kind === "suppressed");
    expect(suppressed?.detail).toMatchObject({ address: "gone@example.net", suppressionReason: "hard_bounce" });
    expect(suppressed?.status).toBeNull();
  });

  it("says nothing on a bounce to an address already on the list", async () => {
    // Suppressed after the send: the API refuses a send to an address already on the list.
    const id = await sentMessage(fixture, "gone@example.net");
    await addSuppression(fixture.organizationId, "gone@example.net");

    await applyEvent(eventSource(fixture), event({ status: "bounced", reason: "550 user unknown", recipients: ["gone@example.net"] }));

    expect((await eventRows(id)).filter((row) => row.kind === "suppressed")).toHaveLength(0);
  });

  it("leaves a deferred message able to return to sent", async () => {
    const id = await sentMessage(fixture);
    await applyEvent(eventSource(fixture), event({ status: "deferred", reason: "greylisted" }));
    expect(await statusOf(id)).toBe("deferred");

    await applyEvent(eventSource(fixture), event({ providerEventId: "event-2", status: "delivered" }));

    expect(await statusOf(id)).toBe("delivered");
  });

  it("never matches a message in another organization", async () => {
    await sentMessage(fixture);
    const other = await seedFixture();

    const result = await applyEvent(eventSource(other), event());

    expect(result.outcome).toBe("unknown_message");
  });

  it("never matches a message on another provider of the same adapter", async () => {
    const id = await sentMessage(fixture);
    const second = await addProvider(fixture, { providerAdapter: "mock" });

    const result = await applyEvent({ id: second.providerId, organizationId: fixture.organizationId }, event());

    expect(result.outcome).toBe("unknown_message");
    expect(await statusOf(id)).toBe("sent");
  });

  it("applies one provider event id on each provider it arrived from", async () => {
    const first = await sentMessage(fixture);
    const second = await addProvider(fixture, { providerAdapter: "mock" });
    const { key } = await addDomainKeyFor(fixture, second.providerId, "second.example.com");
    const { message } = await acceptMessage(
      key,
      { from: "Ada <ada@second.example.com>", to: ["person@example.net"], subject: "Hello", html: "<p>Hi</p>" },
      null,
    );
    // Mailpace numbers per server, so the same pair of ids reaches both providers.
    await db
      .update(messages)
      .set({ status: "sent", providerId: second.providerId, providerMessageId: "provider-1", sentAt: new Date() })
      .where(eq(messages.id, message.id));

    await applyEvent(eventSource(fixture), event());
    const other = await applyEvent(
      { id: second.providerId, organizationId: fixture.organizationId },
      event(),
    );

    expect(other.outcome).toBe("recorded");
    expect(await statusOf(first)).toBe("delivered");
    expect(await statusOf(message.id)).toBe("delivered");
  });

  it("rolls the event back when the suppression fails, so the provider's retry can apply it", async () => {
    const id = await sentMessage(fixture, "gone@example.net");
    // A NUL byte is the one thing Postgres refuses in a text column, so the suppression insert
    // fails after the event row is written. Any error there has the same shape.
    const poisoned = event({ status: "bounced", reason: "550 5.1.1 user unknown", recipients: ["\u0000@example.net"] });

    await expect(applyEvent(eventSource(fixture), poisoned)).rejects.toThrow();

    expect((await eventRows(id)).filter((row) => row.status === "bounced")).toHaveLength(0);

    const retry = event({ status: "bounced", reason: "550 5.1.1 user unknown", recipients: ["gone@example.net"] });
    const result = await applyEvent(eventSource(fixture), retry);

    expect(result.outcome).toBe("recorded");
    expect(await statusOf(id)).toBe("bounced");
    expect(await db.select().from(suppressions)).toHaveLength(1);
  });

  it("suppresses only the address SES names as bounced, in a three-recipient send", async () => {
    // The shape a real Bounce notification carries, per tests/unit/ses.test.ts's "carries the
    // bounce diagnostic verbatim and names the bounced recipient": `destination` lists everyone
    // the message went to, `bouncedRecipients` names only who bounced.
    const sesEvent = event({ status: "bounced", reason: "smtp; 550 5.1.1 user unknown", recipients: ["gone@example.net"] });
    const id = await sentMessageTo(fixture, ["good1@example.net", "gone@example.net", "good2@example.net"]);

    await applyEvent(eventSource(fixture), sesEvent);

    expect(await statusOf(id)).toBe("bounced");
    const suppressedRows = await db.select().from(suppressions).where(eq(suppressions.organizationId, fixture.organizationId));
    expect(suppressedRows.map((row) => row.address)).toEqual(["gone@example.net"]);

    const rows = await historyFor(fixture.organizationId, ["good1@example.net", "gone@example.net", "good2@example.net"]);
    const byAddress = Object.fromEntries(rows.map((row) => [row.address, row.bounceCount]));
    expect(byAddress["gone@example.net"]).toBe(1);
    expect(byAddress["good1@example.net"] ?? 0).toBe(0);
    expect(byAddress["good2@example.net"] ?? 0).toBe(0);
  });

  it("marks only the address SES's Delivery notification names, in a three-recipient send", async () => {
    // The shape a real Delivery notification carries: `mail.destination` lists everyone the
    // message went to, `delivery.recipients` names only who this notification is about — SES
    // sends one Delivery notification per recipient, not one for the whole send.
    const provider = buildAdapter(
      "ses",
      { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", region: "us-west-2" },
      { topicArn: "arn:aws:sns:us-west-2:123456789012:mail-events-example-com" },
    );
    const envelope = {
      Type: "Notification",
      MessageId: "sns-message-1",
      TopicArn: "arn:aws:sns:us-west-2:123456789012:mail-events-example-com",
      Timestamp: "2026-09-08T10:00:00.000Z",
      Message: JSON.stringify({
        eventType: "Delivery",
        mail: {
          messageId: "provider-1",
          timestamp: "2026-09-08T10:00:00.000Z",
          destination: ["good1@example.net", "gone@example.net", "good2@example.net"],
        },
        delivery: {
          timestamp: "2026-09-08T10:00:02.000Z",
          recipients: ["good1@example.net"],
        },
      }),
    };
    const [sesEvent] = provider.events.parse({ rawBody: JSON.stringify(envelope), headers: {} });
    if (!sesEvent) throw new Error("ses didn't parse its own Delivery notification");

    const id = await sentMessageTo(fixture, ["good1@example.net", "gone@example.net", "good2@example.net"]);

    await applyEvent(eventSource(fixture), sesEvent);

    expect(await statusOf(id)).toBe("delivered");
    const [transition] = (await eventRows(id)).filter((row) => row.status === "delivered");
    expect(transition?.detail).toMatchObject({ recipients: ["good1@example.net"] });

    const rows = await historyFor(fixture.organizationId, ["good1@example.net", "gone@example.net", "good2@example.net"]);
    const byAddress = Object.fromEntries(rows.map((row) => [row.address, row.lastDeliveredAt]));
    expect(byAddress["good1@example.net"]).not.toBeNull();
    expect(byAddress["gone@example.net"] ?? null).toBeNull();
    expect(byAddress["good2@example.net"] ?? null).toBeNull();
  });

  it("mailpace's ambiguous To header suppresses nobody, rather than every recipient", async () => {
    // Mailpace's own webhook shape (tests/unit/mailpace-webhook.test.ts): `to` is the full To
    // header, comma-joined. With three recipients it can't say which one bounced — this is the
    // shape that made #149 suppress a whole send over one bad address.
    const provider = buildAdapter("mailpace", { serverToken: "test-token" }, {});
    const webhook = JSON.stringify({
      event: "email.bounced",
      payload: {
        status: "bounced",
        id: "provider-1",
        to: "good1@example.net,gone@example.net,good2@example.net",
        error: "smtp; 550 5.1.1 user unknown",
        updated_at: "2026-09-08T10:00:04.000Z",
      },
    });
    const [mailpaceEvent] = provider.events.parse({ rawBody: webhook, headers: {} });
    if (!mailpaceEvent) throw new Error("mailpace didn't parse its own bounce webhook");

    const id = await sentMessageTo(fixture, ["good1@example.net", "gone@example.net", "good2@example.net"]);

    await applyEvent(eventSource(fixture), mailpaceEvent);

    expect(await statusOf(id)).toBe("bounced");
    expect(await db.select().from(suppressions)).toHaveLength(0);

    const rows = await historyFor(fixture.organizationId, ["good1@example.net", "gone@example.net", "good2@example.net"]);
    expect(rows.every((row) => row.bounceCount === 0)).toBe(true);

    const [transition] = (await eventRows(id)).filter((row) => row.status === "bounced");
    expect(transition?.detail).toMatchObject({ recipientsNamed: false });
  });

  it("suppresses nobody and writes no history when the provider names no recipient", async () => {
    const id = await sentMessageTo(fixture, ["good1@example.net", "good2@example.net", "good3@example.net"]);

    const result = await applyEvent(eventSource(fixture), event({ status: "bounced", reason: "550 5.1.1 user unknown", recipients: [] }));

    expect(result.outcome).toBe("recorded");
    expect(await statusOf(id)).toBe("bounced");
    expect(await db.select().from(suppressions)).toHaveLength(0);

    const rows = await historyFor(fixture.organizationId, ["good1@example.net", "good2@example.net", "good3@example.net"]);
    expect(rows.every((row) => row.bounceCount === 0)).toBe(true);

    const [transition] = (await eventRows(id)).filter((row) => row.status === "bounced");
    expect(transition?.detail).toMatchObject({ recipientsNamed: false });
  });
});

describe("a complaint after delivery", () => {
  /** Delivered first, which is the only order a real complaint arrives in. */
  async function deliveredMessage(to = "angry@example.net"): Promise<string> {
    const id = await sentMessage(fixture, to);
    await applyEvent(eventSource(fixture), event({ status: "delivered", providerEventId: "delivered-1", recipients: [to] }));
    expect(await statusOf(id)).toBe("delivered");
    return id;
  }

  it("moves the message to complained and keeps delivered_at, because it did arrive", async () => {
    const id = await deliveredMessage();

    const result = await applyEvent(
      eventSource(fixture),
      event({ status: "complained", providerEventId: "complaint-1", reason: "abuse" }),
    );

    expect(result.statusChanged).toBe(true);
    expect(await statusOf(id)).toBe("complained");
    const [row] = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
    expect(row?.deliveredAt).not.toBeNull();
  });

  it("takes an asynchronous bounce after delivery too", async () => {
    const id = await deliveredMessage("gone@example.net");

    await applyEvent(
      eventSource(fixture),
      event({ status: "bounced", providerEventId: "bounce-1", reason: "550 5.1.1 user unknown", recipients: ["gone@example.net"] }),
    );

    expect(await statusOf(id)).toBe("bounced");
    expect(await db.select().from(suppressions)).toHaveLength(1);
  });

  it("still refuses to walk a complained message backwards", async () => {
    const id = await deliveredMessage();
    await applyEvent(eventSource(fixture), event({ status: "complained", providerEventId: "complaint-1" }));

    const late = await applyEvent(eventSource(fixture), event({ status: "delivered", providerEventId: "delivered-2" }));

    expect(late.outcome).toBe("recorded");
    expect(late.statusChanged).toBe(false);
    expect(await statusOf(id)).toBe("complained");
  });
});

describe("a provider that emits its own send event", () => {
  /** The worker's write: status on the row, and a self-raised event with no provider event id. */
  async function workerSent(messageId: string, at: Date): Promise<void> {
    await recordEvent({
      organizationId: fixture.organizationId,
      messageId,
      status: "sent",
      occurredAt: at,
    });
  }

  it("attaches to the worker's row instead of adding a second sent", async () => {
    const handedOver = new Date("2026-09-08T04:15:11.000Z");
    const confirmed = new Date("2026-09-08T04:15:11.700Z");
    const id = await sentMessage(fixture);
    await workerSent(id, handedOver);

    const result = await applyEvent(
      eventSource(fixture),
      event({ status: "sent", providerEventId: "ses-send-1", occurredAt: confirmed }),
    );

    expect(result.outcome).toBe("recorded");

    const sent = (await eventRows(id)).filter((row) => row.status === "sent");
    expect(sent).toHaveLength(1);
    // The provider's id is what makes its retry a duplicate from here on, and its timestamp is
    // the more authoritative of the two.
    expect(sent[0]?.providerEventId).toBe("ses-send-1");
    expect(sent[0]?.occurredAt.toISOString()).toBe(confirmed.toISOString());
  });

  it("leaves the message sent, since nothing transitioned", async () => {
    const id = await sentMessage(fixture);
    await workerSent(id, new Date());

    await applyEvent(eventSource(fixture), event({ status: "sent", providerEventId: "ses-send-1" }));

    expect(await statusOf(id)).toBe("sent");
  });

  it("treats a retried send webhook as a duplicate", async () => {
    const id = await sentMessage(fixture);
    await workerSent(id, new Date());
    const send = event({ status: "sent", providerEventId: "ses-send-1" });

    await applyEvent(eventSource(fixture), send);
    const retry = await applyEvent(eventSource(fixture), send);

    expect(retry.outcome).toBe("duplicate");
    expect((await eventRows(id)).filter((row) => row.status === "sent")).toHaveLength(1);
  });

  it("keeps each attempt's sent when a deferred message sends again", async () => {
    const id = await sentMessage(fixture);
    await workerSent(id, new Date("2026-09-08T04:15:11.000Z"));
    await applyEvent(eventSource(fixture), event({ status: "sent", providerEventId: "ses-send-1" }));

    // Deferred and re-sent: the worker raises a second sent, and it's a different transition.
    await applyEvent(eventSource(fixture), event({ status: "deferred", providerEventId: "ses-defer-1" }));
    await workerSent(id, new Date("2026-09-08T04:20:00.000Z"));
    await applyEvent(eventSource(fixture), event({ status: "sent", providerEventId: "ses-send-2" }));

    const sent = (await eventRows(id)).filter((row) => row.status === "sent");
    expect(sent).toHaveLength(2);
    expect(sent.map((row) => row.providerEventId).sort()).toEqual(["ses-send-1", "ses-send-2"]);
  });
});

describe("a provider that emits no send event", () => {
  it("still shows sent once, from the worker's own write", async () => {
    const id = await sentMessage(fixture);
    await recordEvent({ organizationId: fixture.organizationId, messageId: id, status: "sent" });

    await applyEvent(eventSource(fixture), event({ status: "delivered", providerEventId: "mp-delivered-1" }));

    const rows = await eventRows(id);
    expect(rows.filter((row) => row.status === "sent")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "delivered")).toHaveLength(1);
    expect(await statusOf(id)).toBe("delivered");
  });
});
