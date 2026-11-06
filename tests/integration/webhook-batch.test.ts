import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { messageEvents, messages } from "@/lib/db/schema";
import { acceptMessage } from "@/lib/messages/create";
import type { NormalizedEvent, SignedRequest } from "@/lib/providers/adapters/types";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

// No shipped provider parses more than one event per request, so the mock provider gets a parser that does and accepts it.
vi.mock("@/lib/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers")>();
  return {
    ...actual,
    adapterFor: (row: Parameters<typeof actual.adapterFor>[0]) => {
      const provider = actual.adapterFor(row);
      const parse = (request: SignedRequest): NormalizedEvent[] =>
        (JSON.parse(request.rawBody) as string[]).map((providerMessageId) => ({
          providerMessageId,
          providerEventId: null,
          status: "delivered",
          reason: null,
          occurredAt: new Date("2026-09-16T10:00:00Z"),
          detail: {},
          recipients: [],
        }));
      return { ...provider, events: { ...provider.events, verify: async () => true, parse } };
    },
  };
});

const failOnCall = vi.hoisted(() => ({ call: 0, failAt: 0 }));

vi.mock("@/lib/messages/history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/messages/history")>();
  return {
    ...actual,
    touchRecipientHistory: async (...args: Parameters<typeof actual.touchRecipientHistory>) => {
      failOnCall.call += 1;
      if (failOnCall.call === failOnCall.failAt) throw new Error("connection reset");
      return actual.touchRecipientHistory(...args);
    },
  };
});

const { POST } = await import("@/app/api/webhooks/[adapter]/[providerId]/route");

function post(providerId: string, body: string): Parameters<typeof POST> {
  const request = new Request(`http://localhost/api/webhooks/mock/${providerId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return [request, { params: Promise.resolve({ adapter: "mock", providerId }) }];
}

async function sentMessage(fixture: Fixture, providerMessageId: string): Promise<string> {
  const { message } = await acceptMessage(
    fixture.key,
    { from: "Ada <ada@example.com>", to: ["person@example.net"], subject: "Hello", html: "<p>Hi</p>" },
    null,
  );
  await db
    .update(messages)
    .set({ status: "sent", providerId: fixture.providerId, providerMessageId, sentAt: new Date() })
    .where(eq(messages.id, message.id));
  return message.id;
}

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
  failOnCall.call = 0;
  failOnCall.failAt = 0;
});

describe("a provider batch", () => {
  it("applies each event once when the third throws and the provider retries the batch", async () => {
    const providerIds = ["p-1", "p-2", "p-3", "p-4", "p-5"];
    const ids = [];
    for (const providerId of providerIds) ids.push(await sentMessage(fixture, providerId));
    const body = JSON.stringify(providerIds);

    failOnCall.failAt = 3;
    const first = await POST(...post(fixture.providerId, body));
    expect(first.status).toBeGreaterThanOrEqual(500);

    const retry = await POST(...post(fixture.providerId, body));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ applied: 5, ignored: 0 });

    const rows = await db.select().from(messageEvents).where(inArray(messageEvents.messageId, ids));
    for (const id of ids) {
      expect(rows.filter((row) => row.messageId === id && row.status === "delivered"), id).toHaveLength(1);
    }
  });
});
