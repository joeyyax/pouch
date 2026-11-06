import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import Redis from "ioredis";
import type { MessageStatus } from "@/lib/db/schema";
import { GET as watchEvents } from "@/app/api/v1/events/route";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { closeRedis } from "@/lib/redis";
import { recordEvent } from "@/lib/messages/events";
import { publishMessageUpdate, updatesChannel } from "@/lib/messages/updates";
import { addDomainKey, resetDatabase, seedFixture, seedMessage as seedFixtureMessage, type Fixture } from "./fixtures";
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
  data?: { id: string };
}

function parseFrame(chunk: string): Frame {
  const frame: Frame = {};
  for (const line of chunk.split("\n")) {
    if (line.startsWith("id: ")) frame.id = line.slice(4);
    else if (line.startsWith("event: ")) frame.event = line.slice(7);
    else if (line.startsWith("data: ")) {
      // The SSE data line carries the whole { id, type, created_at, data } frame; `data.data`
      // is the message itself — the same shape a webhook posts.
      const payload = JSON.parse(line.slice(6)) as { data: { id: string } };
      frame.data = payload.data;
    }
  }
  return frame;
}

/** Reads real (non-comment) frames until `done` is satisfied or `limitMs` runs out, then cancels the stream. */
async function collectFrames(response: Response, done: (frames: Frame[]) => boolean, limitMs = 5000): Promise<Frame[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: Frame[] = [];
  const deadline = Date.now() + limitMs;

  while (!done(frames)) {
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
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!chunk.startsWith(":")) frames.push(parseFrame(chunk));
    }
  }
  await reader.cancel().catch(() => {});
  return frames;
}

/** Resolves once the route's Redis subscription to the organization's channel is attached. */
async function subscribed(organizationId: string): Promise<void> {
  const probe = new Redis(REDIS_URL);
  try {
    const deadline = Date.now() + 5000;
    for (;;) {
      const [, count] = (await probe.pubsub("NUMSUB", updatesChannel(organizationId))) as [string, number];
      if (Number(count) > 0) return;
      if (Date.now() > deadline) throw new Error("the stream never subscribed");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await probe.quit().catch(() => probe.disconnect());
  }
}

function request(secret: string, query = ""): Request {
  return new Request(`http://localhost/v1/events${query}`, { headers: { authorization: `Bearer ${secret}` } });
}

async function seedMessage(domainId: string, status: MessageStatus = "queued"): Promise<string> {
  return seedFixtureMessage({ organizationId: fixture.organizationId, domainId }, { status, to: "sam@example.com", subject: "Hello" });
}

async function transition(messageId: string, status: MessageStatus): Promise<void> {
  await recordEvent({ organizationId: fixture.organizationId, messageId, status, occurredAt: new Date() });
  await publishMessageUpdate(fixture.organizationId, { messageId, status });
}

describe("GET /v1/events", () => {
  beforeEach(async () => {
    process.env.REDIS_URL = REDIS_URL;
    await closeRedis();
  });

  it("answers 503 when Redis isn't available — nothing here can be held open without it", async () => {
    delete process.env.REDIS_URL;
    await closeRedis();

    const response = await watchEvents(request(fixture.secret));
    expect(response.status).toBe(503);
  });

  it("a key scoped to one domain never sees another domain's events on the org channel", async () => {
    const scoped = await addDomainKey(fixture, "scoped.example.com");
    const scopedMessageId = await seedMessage(scoped.domainId, "queued");
    const otherMessageId = await seedMessage(fixture.domainId, "queued");

    const response = await watchEvents(request(scoped.secret));
    expect(response.status).toBe(200);

    await subscribed(fixture.organizationId);

    await transition(otherMessageId, "sent"); // on a domain this key can't see
    await transition(scopedMessageId, "sent"); // on the key's own domain
    // Frames arrive in order, so once this one lands nothing earlier is still on its way.
    const lastMessageId = await seedMessage(scoped.domainId, "queued");
    await transition(lastMessageId, "sent");

    const frames = await collectFrames(response, (seen) => seen.some((f) => f.data?.id === lastMessageId));

    expect(frames.map((f) => f.data?.id)).toEqual([scopedMessageId, lastMessageId]);
    expect(frames.some((f) => f.data?.id === otherMessageId)).toBe(false);
  });

  it("filters to the requested type", async () => {
    const messageId = await seedMessage(fixture.domainId, "queued");

    const response = await watchEvents(request(fixture.secret, "?type=email.delivered"));
    expect(response.status).toBe(200);
    await subscribed(fixture.organizationId);

    await transition(messageId, "sent");
    await transition(messageId, "delivered");

    const frames = await collectFrames(response, (seen) => seen.some((f) => f.event === "email.delivered"));

    expect(frames.map((f) => f.event)).toEqual(["email.delivered"]);
  });

  it("rejects an unknown type", async () => {
    const response = await watchEvents(request(fixture.secret, "?type=not.a.real.type"));
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string; field?: string } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.field).toBe("type");
  });
});
