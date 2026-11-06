import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages } from "@/lib/db/schema";
import { POST } from "@/app/api/v1/emails/route";
import { POST as RECEIVE_WEBHOOK } from "@/app/api/webhooks/[adapter]/[providerId]/route";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { claimMessages, dueProviders } from "@/lib/messages/queue";
import { runWithRequestId } from "@/lib/api/request-context";
import { deliver } from "@/worker/send";
import { resetMockSends } from "@/lib/providers/adapters/mock";
import { resetDatabase, seedFixture } from "./fixtures";

const REQUEST_ID = "caller-trace-abc123";

const valid = { from: "Ada <ada@example.com>", to: "person@example.net", subject: "Hello", html: "<p>Hi</p>" };

function post(secret: string, requestId?: string): Request {
  return new Request("http://localhost/v1/emails", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
      ...(requestId ? { "x-request-id": requestId } : {}),
    },
    body: JSON.stringify(valid),
  });
}

let lines: string[];

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  resetMockSends();
  lines = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  }
});
afterEach(() => vi.restoreAllMocks());

/** Every captured line tagged with the request id under test. */
function tagged(): string[] {
  return lines.filter((line) => line.includes(REQUEST_ID));
}

describe("tracing a message from logs alone", () => {
  it("ties the request id to the message id at accept, and carries it into the worker", async () => {
    const fixture = await seedFixture();

    const response = await POST(post(fixture.secret, REQUEST_ID));
    const { id } = (await response.json()) as { id: string };

    expect(response.status).toBe(202);
    expect(tagged().some((line) => line.includes(`accepted ${id}`))).toBe(true);

    const [row] = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
    expect(row?.requestId).toBe(REQUEST_ID);

    const [provider] = await dueProviders();
    const [claimed] = await claimMessages({ workerId: "worker-trace", providerId: provider!.id, limit: 1 });
    await runWithRequestId(claimed!.message.requestId, () => deliver(claimed!, "worker-trace"));

    expect(tagged().some((line) => line.includes(`sent ${id}`))).toBe(true);
  });

  it("mints an id for a send that arrives without one", async () => {
    const fixture = await seedFixture();

    const response = await POST(post(fixture.secret));
    const { id } = (await response.json()) as { id: string };

    const [row] = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
    expect(row?.requestId).toMatch(/^req_[a-z0-9]{24}$/);
    expect(response.headers.get("x-request-id")).toBe(row?.requestId);
  });

  it("tags a provider webhook, which authenticates by signature rather than by key", async () => {
    const request = new Request("http://localhost/api/webhooks/nothing/prov_missing", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": REQUEST_ID },
      body: "{}",
    });

    const response = await RECEIVE_WEBHOOK(request, { params: Promise.resolve({ adapter: "nothing", providerId: "prov_missing" }) });

    expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
  });
});
