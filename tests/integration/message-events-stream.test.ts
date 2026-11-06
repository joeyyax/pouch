import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages } from "@/lib/db/schema";
import type { MessageStatus } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { GET as watchMessage } from "@/app/api/v1/emails/[id]/events/route";
import { acquireStreamSlot, maxConcurrentStreams, resetRateLimitMemory } from "@/lib/api/rate-limit";
import { closeRedis } from "@/lib/redis";
import { recordEvent } from "@/lib/messages/events";
import { addDomainKey, resetDatabase, routeContext, seedFixture, type Fixture } from "./fixtures";
import { testRedisUrl } from "../redis";

const REDIS_URL = testRedisUrl();

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  fixture = await seedFixture({ scopeToDomain: false });
});

afterEach(async () => {
  delete process.env.REDIS_URL;
  await closeRedis();
});

afterAll(() => {
  delete process.env.REDIS_URL;
});

interface Frame {
  id?: string;
  event?: string;
  data?: { id: string; status: MessageStatus };
}

function parseFrames(chunks: string[]): Frame[] {
  return chunks
    .filter((chunk) => !chunk.startsWith(":"))
    .map((chunk) => {
      const frame: Frame = {};
      for (const line of chunk.split("\n")) {
        if (line.startsWith("id: ")) frame.id = line.slice(4);
        else if (line.startsWith("event: ")) frame.event = line.slice(7);
        else if (line.startsWith("data: ")) {
          // The SSE data line carries the whole { id, type, created_at, data } frame; `data.data`
          // is the message itself — the same shape a webhook posts.
          const payload = JSON.parse(line.slice(6)) as { data: { id: string; status: MessageStatus } };
          frame.data = payload.data;
        }
      }
      return frame;
    });
}

/** Reads a stream's SSE frames until it closes on its own or the deadline passes. */
async function readFrames(response: Response, timeoutMs = 2000): Promise<Frame[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const chunks: string[] = [];
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const result = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), remaining)),
    ]);
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      chunks.push(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }
  await reader.cancel().catch(() => {});
  return parseFrames(chunks);
}

function request(secret: string, id: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/v1/emails/${id}/events`, {
    headers: { authorization: `Bearer ${secret}`, ...headers },
  });
}

/** Inserts a message row directly, mirroring the emails-list fixture helper. */
async function seedMessage(domainId: string, status: MessageStatus = "queued"): Promise<string> {
  const id = newId("message");
  await db.insert(messages).values({
    id,
    organizationId: fixture.organizationId,
    domainId,
    status,
    fromAddress: "hi@example.com",
    recipients: ["sam@example.com"],
    subject: "Hello",
    envelope: {
      from: "hi@example.com",
      fromName: null,
      to: ["sam@example.com"],
      cc: [],
      bcc: [],
      replyTo: [],
      headers: {},
      attachmentCount: 0,
    },
  });
  return id;
}

async function addTransition(messageId: string, status: MessageStatus, occurredAt = new Date()): Promise<string> {
  const eventId = await recordEvent({ organizationId: fixture.organizationId, messageId, status, occurredAt });
  if (!eventId) throw new Error("expected a new event row");
  return eventId;
}

describe("GET /v1/emails/:id/events", () => {
  it("replays a terminal message's transitions and closes without touching Redis", async () => {
    const messageId = await seedMessage(fixture.domainId, "queued");
    const queuedAt = new Date(Date.now() - 3000);
    const sentAt = new Date(Date.now() - 2000);
    const deliveredAt = new Date(Date.now() - 1000);
    await addTransition(messageId, "queued", queuedAt);
    await addTransition(messageId, "sent", sentAt);
    const deliveredEventId = await addTransition(messageId, "delivered", deliveredAt);
    await db.update(messages).set({ status: "delivered", deliveredAt }).where(eq(messages.id, messageId));

    const response = await watchMessage(request(fixture.secret, messageId), routeContext(messageId));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const frames = await readFrames(response);
    expect(frames.map((f) => f.event)).toEqual(["email.queued", "email.sent", "email.delivered"]);
    expect(frames.at(-1)?.id).toBe(deliveredEventId);
    expect(frames.every((f) => f.data?.id === messageId)).toBe(true);
    expect(frames.every((f) => f.data?.status === "delivered")).toBe(true);
  });

  it("honors Last-Event-ID, replaying only what's new since it", async () => {
    const messageId = await seedMessage(fixture.domainId, "failed");
    const firstId = await addTransition(messageId, "queued", new Date(Date.now() - 2000));
    const secondId = await addTransition(messageId, "sent", new Date(Date.now() - 1000));
    await addTransition(messageId, "failed", new Date());

    const response = await watchMessage(request(fixture.secret, messageId, { "last-event-id": firstId }), routeContext(messageId));
    const frames = await readFrames(response);

    expect(frames.map((f) => f.event)).toEqual(["email.sent", "email.failed"]);
    expect(frames[0]?.id).toBe(secondId);
  });

  it("ignores an unknown Last-Event-ID and replays from the start", async () => {
    const messageId = await seedMessage(fixture.domainId, "failed");
    await addTransition(messageId, "queued", new Date(Date.now() - 1000));
    await addTransition(messageId, "failed", new Date());

    const response = await watchMessage(request(fixture.secret, messageId, { "last-event-id": "evt_doesnotexist" }), routeContext(messageId));
    const frames = await readFrames(response);

    expect(frames.map((f) => f.event)).toEqual(["email.queued", "email.failed"]);
  });

  it("refuses a key that isn't scoped to the message's domain", async () => {
    const other = await addDomainKey(fixture, "other.example.com");
    const messageId = await seedMessage(fixture.domainId, "delivered");
    await addTransition(messageId, "delivered", new Date());

    const response = await watchMessage(request(other.secret, messageId), routeContext(messageId));
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("key_not_scoped");
  });

  it("answers not_found for a message the key's organization doesn't have", async () => {
    const missingId = newId("message");
    const response = await watchMessage(request(fixture.secret, missingId), routeContext(missingId));
    expect(response.status).toBe(404);
  });
});

describe("stream concurrency ceiling", () => {
  beforeEach(async () => {
    process.env.REDIS_URL = REDIS_URL;
    await closeRedis();
  });

  it("acquireStreamSlot refuses past the limit and frees a slot on release", async () => {
    const limit = 2;
    const first = await acquireStreamSlot(fixture.key.id, limit);
    const second = await acquireStreamSlot(fixture.key.id, limit);
    const third = await acquireStreamSlot(fixture.key.id, limit);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third).toEqual({ ok: false, reason: "limit" });

    if (first.ok) await first.slot.release();
    const fourth = await acquireStreamSlot(fixture.key.id, limit);
    expect(fourth.ok).toBe(true);
    if (second.ok) await second.slot.release();
    if (fourth.ok) await fourth.slot.release();
  });

  it("answers 429 stream_limit_exceeded once a key's ceiling is spent", async () => {
    const limit = maxConcurrentStreams();
    const slots = [];
    for (let i = 0; i < limit; i += 1) {
      const outcome = await acquireStreamSlot(fixture.key.id, limit);
      if (!outcome.ok) throw new Error("expected a free slot while filling the ceiling");
      slots.push(outcome.slot);
    }

    const messageId = await seedMessage(fixture.domainId, "queued");
    const response = await watchMessage(request(fixture.secret, messageId), routeContext(messageId));
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("stream_limit_exceeded");

    await Promise.all(slots.map((slot) => slot.release()));
  });
});
