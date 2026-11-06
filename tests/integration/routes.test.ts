import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { apiKeys, domains, listMemberships } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { GET } from "@/app/api/v1/emails/[id]/route";
import { POST } from "@/app/api/v1/emails/route";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { dbNow } from "@/lib/db/clock";
import { DEFAULT_STALL_LINES, type StallVerdict } from "@/lib/domains/guard";
import { stallDomain } from "@/lib/domains/stall";
import { recordOccurrence } from "@/lib/messages/events";
import { createList } from "@/lib/lists";
import { providerActor, userActor, workerActor } from "@/lib/activity/record";
import { suspendOrganization } from "@/lib/suspension";
import { addDomainKey, resetDatabase, seedFixture } from "./fixtures";

vi.mock("@/lib/notifications/push/push", () => ({ sendPushAlert: vi.fn().mockResolvedValue(undefined) }));

interface ErrorBody {
  error: { code: string; message: string; field?: string; detail?: Record<string, unknown> };
}

function post(secret: string | null, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/v1/emails", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const valid = { from: "Ada <ada@example.com>", to: "person@example.net", subject: "Hello", html: "<p>Hi</p>" };

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
});

describe("POST /v1/emails", () => {
  it("accepts a valid send with 202 and a queued message", async () => {
    const fixture = await seedFixture();

    const response = await POST(post(fixture.secret, valid));
    const body = (await response.json()) as { id: string; status: string; to: string[] };

    expect(response.status).toBe(202);
    expect(body.status).toBe("queued");
    expect(body.id).toMatch(/^msg_/);
    expect(body.to).toEqual(["person@example.net"]);
  });

  it("points Location and url at the message it accepted", async () => {
    const fixture = await seedFixture();

    const response = await POST(post(fixture.secret, valid));
    const body = (await response.json()) as { id: string; url: string };

    expect(body.url).toMatch(new RegExp(`^https?://[^/]+/v1/emails/${body.id}$`));
    expect(response.headers.get("location")).toBe(body.url);
  });

  it("rejects a missing key with 401", async () => {
    const response = await POST(post(null, valid));
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("invalid_key");
  });

  it("rejects an unknown key with 401 and no hint about which part was wrong", async () => {
    const response = await POST(post("sk_live_notarealkey", valid));
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(401);
    expect(body.error.message).toBe("This key isn't valid.");
  });

  it("rejects malformed JSON with 400", async () => {
    const fixture = await seedFixture();

    const response = await POST(post(fixture.secret, "{not json"));
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_json");
  });

  it("names the missing field in a validation error", async () => {
    const fixture = await seedFixture();
    const { to: _to, ...withoutTo } = valid;

    const response = await POST(post(fixture.secret, withoutTo));
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.field).toBe("to");
    expect(body.error.message).toBe('Field "to" is required.');
  });

  it("distinguishes a present-but-wrong field from a missing one", async () => {
    const fixture = await seedFixture();

    const response = await POST(post(fixture.secret, { ...valid, to: 5 }));
    const body = (await response.json()) as ErrorBody;

    expect(body.error.field).toBe("to");
    expect(body.error.message).toMatch(/^Field "to" isn't valid: /);
  });

  it("rejects a subscribe naming a list that isn't on the sending domain", async () => {
    const fixture = await seedFixture();

    const response = await POST(post(fixture.secret, { ...valid, subscribe: ["lst_123"] }));
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.field).toBe("subscribe");
  });

  it("adds every recipient to the named list, as an api membership carrying this message's id", async () => {
    const fixture = await seedFixture();
    const list = await createList(
      { organizationId: fixture.organizationId, domainIds: [], actor: { type: "worker", id: null, label: "test" } },
      { domain_id: fixture.domainId, name: "Newsletter" },
    );

    const response = await POST(post(fixture.secret, { ...valid, subscribe: [list.id] }));
    const body = (await response.json()) as { id: string };
    expect(response.status).toBe(202);

    const [membership] = await db.select().from(listMemberships).where(eq(listMemberships.listId, list.id));
    expect(membership?.address).toBe("person@example.net");
    expect(membership?.source).toBe("api");
    expect(membership?.sourceMessageId).toBe(body.id);
    expect(membership?.status).toBe("pending");
  });

  it("returns the original id on an idempotent repeat", async () => {
    const fixture = await seedFixture();
    const headers = { "idempotency-key": "order-99" };

    const first = (await (await POST(post(fixture.secret, valid, headers))).json()) as { id: string };
    const second = (await (await POST(post(fixture.secret, valid, headers))).json()) as { id: string };

    expect(second.id).toBe(first.id);
  });

  it("treats an empty idempotency header as no key", async () => {
    const fixture = await seedFixture();

    const first = await POST(post(fixture.secret, valid, { "idempotency-key": "" }));
    const second = await POST(post(fixture.secret, valid, { "idempotency-key": "  " }));

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const [a, b] = await Promise.all([first.json(), second.json()]) as { id: string }[];
    expect(a?.id).not.toBe(b?.id);
  });

  it("returns 409 when the same idempotency key carries a different body", async () => {
    const fixture = await seedFixture();
    const headers = { "idempotency-key": "order-100" };
    await POST(post(fixture.secret, valid, headers));

    const response = await POST(post(fixture.secret, { ...valid, subject: "Other" }, headers));
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("idempotency_conflict");
  });

  it("returns rate limit headers on a successful send", async () => {
    const fixture = await seedFixture();

    const response = await POST(post(fixture.secret, valid));

    expect(response.headers.get("x-ratelimit-limit")).toBe(String(fixture.key.rateLimit));
    expect(Number(response.headers.get("x-ratelimit-remaining"))).toBe(fixture.key.rateLimit - 1);
  });

  it("returns 429 with Retry-After once the key's limit is spent", async () => {
    const fixture = await seedFixture();
    // Set here rather than inherited: this is about the limiter, not about what the default is.
    const limit = 5;
    await db.update(apiKeys).set({ rateLimit: limit }).where(eq(apiKeys.id, fixture.key.id));
    // Pinned inside one bucket. The window is approximate by design — a burst straddling a
    // boundary admits a few percent over the limit, which docs/api/conventions.md documents
    // and which made this test fail on a loaded machine and pass on a quiet one (#85).
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      for (let i = 0; i < limit; i++) await POST(post(fixture.secret, valid));

      const response = await POST(post(fixture.secret, valid));
      const body = (await response.json()) as ErrorBody;

      expect(response.status).toBe(429);
      expect(body.error.code).toBe("rate_limit_exceeded");
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects a body past the size limit before parsing it", async () => {
    const fixture = await seedFixture();
    const request = new Request("http://localhost/v1/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(40 * 1024 * 1024),
        authorization: `Bearer ${fixture.secret}`,
      },
      body: JSON.stringify(valid),
    });

    const response = await POST(request);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("attachment_too_large");
  });

  it("sets content-type to JSON on an error, not only on success", async () => {
    const response = await POST(post(null, valid));

    expect(response.headers.get("content-type")).toBe("application/json");
  });
});

describe("GET /v1/emails/:id", () => {
  async function params(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  function get(secret: string): Request {
    return new Request("http://localhost/v1/emails/x", { headers: { authorization: `Bearer ${secret}` } });
  }

  it("returns the message with its event timeline", async () => {
    const fixture = await seedFixture();
    const created = (await (await POST(post(fixture.secret, valid))).json()) as { id: string };

    const response = await GET(get(fixture.secret), await params(created.id));
    const body = (await response.json()) as {
      id: string;
      status: string;
      events: { status: string }[];
    };

    expect(response.status).toBe(200);
    expect(body.id).toBe(created.id);
    expect(body.status).toBe("queued");
    expect(body.events.map((event) => event.status)).toEqual(["queued"]);
  });

  it("keeps events to the lifecycle, leaving occurrences to the dashboard", async () => {
    const fixture = await seedFixture();
    const created = (await (await POST(post(fixture.secret, valid))).json()) as { id: string };
    await recordOccurrence({
      organizationId: fixture.organizationId,
      messageId: created.id,
      kind: "retry",
      reason: "Temporary failure, try again",
      detail: { attempt: 1, nextAttemptAt: new Date().toISOString() },
    });

    const body = (await (await GET(get(fixture.secret), await params(created.id))).json()) as {
      events: { status: string }[];
    };

    expect(body.events.map((event) => event.status)).toEqual(["queued"]);
  });

  it("carries the message url", async () => {
    const fixture = await seedFixture();
    const created = (await (await POST(post(fixture.secret, valid))).json()) as { id: string };

    const body = (await (await GET(get(fixture.secret), await params(created.id))).json()) as { url: string };

    expect(body.url).toMatch(new RegExp(`^https?://[^/]+/v1/emails/${created.id}$`));
  });

  it("returns 404 for an id that does not exist", async () => {
    const fixture = await seedFixture();

    const response = await GET(get(fixture.secret), await params("msg_doesnotexist0000000000"));
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  it("returns 404 for another organization's message rather than leaking its existence", async () => {
    const fixture = await seedFixture();
    const other = await seedFixture();
    const created = (await (await POST(post(other.secret, valid))).json()) as { id: string };

    const response = await GET(get(fixture.secret), await params(created.id));

    expect(response.status).toBe(404);
  });

  it("keeps the body out of the response", async () => {
    const fixture = await seedFixture();
    const created = (await (await POST(post(fixture.secret, valid))).json()) as { id: string };

    const response = await GET(get(fixture.secret), await params(created.id));

    expect(await response.text()).not.toContain("<p>Hi</p>");
  });

  it("returns key_not_scoped when the key is scoped to a different domain than the message", async () => {
    const fixture = await seedFixture();
    const scoped = await addDomainKey(fixture);
    const created = (await (await POST(post(fixture.secret, valid))).json()) as { id: string };

    const response = await GET(get(scoped.secret), await params(created.id));
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("key_not_scoped");
  });

  it("returns 401 invalid_key for a revoked key, with no hint that the key exists", async () => {
    const fixture = await seedFixture();
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, fixture.key.id));

    const response = await POST(post(fixture.secret, valid));
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("invalid_key");
    expect(body.error.message).toBe("This key isn't valid.");
  });

  it("carries the domain's stall reason when the message is queued and the domain is held", async () => {
    const fixture = await seedFixture();
    const created = (await (await POST(post(fixture.secret, valid))).json()) as { id: string };

    const [domain] = await db.select().from(domains).where(eq(domains.id, fixture.domainId));
    const verdict: StallVerdict = {
      reason: "bounce_rate",
      detail: { metric: "bounce", count: 10, denominator: 100, rate: 0.1, previousRate: 0.1, threshold: DEFAULT_STALL_LINES.bounce.stall },
    };
    const stalledAt = await dbNow();
    await stallDomain(domain!, verdict, stalledAt);

    const body = (await (await GET(get(fixture.secret), await params(created.id))).json()) as {
      status: string;
      stall: { kind: string; reason: string; message: string; stalled_at: string } | null;
    };

    expect(body.status).toBe("queued");
    expect(body.stall).toEqual({
      kind: "domain",
      reason: "bounce_rate",
      message: "Bounce rate is 10.00%, above our 2.50% action point.",
      stalled_at: stalledAt.toISOString(),
    });
  });

  it("is null when the message is queued and its domain isn't stalled", async () => {
    const fixture = await seedFixture();
    const created = (await (await POST(post(fixture.secret, valid))).json()) as { id: string };

    const body = (await (await GET(get(fixture.secret), await params(created.id))).json()) as {
      stall: unknown;
    };

    expect(body.stall).toBeNull();
  });

  it("carries a provider_paused stall when the provider suspended the organization", async () => {
    const fixture = await seedFixture();
    const created = (await (await POST(post(fixture.secret, valid))).json()) as { id: string };

    const suspendedAt = await dbNow();
    await suspendOrganization(
      fixture.organizationId,
      { source: "provider", reason: "The email provider paused sending for this organization." },
      providerActor("pac_1", "Hosted"),
      suspendedAt,
    );

    const body = (await (await GET(get(fixture.secret), await params(created.id))).json()) as { status: string; stall: unknown };

    expect(body.status).toBe("queued");
    expect(body.stall).toEqual({
      kind: "organization",
      reason: "provider_paused",
      message: "The email provider paused sending for this organization.",
      stalled_at: suspendedAt.toISOString(),
    });
  });

  it("is null under a manual suspension, which fails the message instead", async () => {
    const fixture = await seedFixture();
    const created = (await (await POST(post(fixture.secret, valid))).json()) as { id: string };
    await suspendOrganization(fixture.organizationId, { source: "manual", reason: "Phishing." }, userActor("u_1", "Olive"));

    const body = (await (await GET(get(fixture.secret), await params(created.id))).json()) as { stall: unknown };

    expect(body.stall).toBeNull();
  });

  it("carries an organization-kind stall when the message is held by a reputation suspension", async () => {
    const fixture = await seedFixture();
    const created = (await (await POST(post(fixture.secret, valid))).json()) as { id: string };

    const suspendedAt = await dbNow();
    await suspendOrganization(
      fixture.organizationId,
      {
        source: "reputation",
        reason: "Bounce rate is 10.00%, above our 2.50% action point.",
        detail: { reason: "bounce_rate", metric: "bounce", count: 10, denominator: 100, rate: 0.1, previousRate: 0.1, threshold: DEFAULT_STALL_LINES.bounce.stall },
      },
      workerActor("Reputation guard"),
      suspendedAt,
    );

    const body = (await (await GET(get(fixture.secret), await params(created.id))).json()) as {
      status: string;
      stall: { kind: string; reason: string; message: string; stalled_at: string } | null;
    };

    expect(body.status).toBe("queued");
    expect(body.stall).toEqual({
      kind: "organization",
      reason: "bounce_rate",
      message: "Bounce rate is 10.00%, above our 2.50% action point.",
      stalled_at: suspendedAt.toISOString(),
    });
  });
});
