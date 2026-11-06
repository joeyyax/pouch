import { describe, expect, it } from "vitest";
import { ROUTES } from "@/lib/api-docs/spec";
import type { ErrorCode } from "@/lib/api/errors";
import { PouchClient, type KnownPouchErrorCode } from "../../sdk/pouch";

/**
 * Documented routes with no SDK method. Every entry needs a reason, and a reason that reads as a
 * to-do belongs in an issue instead.
 */
const NO_SDK: Record<string, string> = {
  "GET /v1/emails/:id/events":
    "text/event-stream, held open until the message reaches a terminal state. The client is request/response; a stream wants an EventSource or a reader loop, not a promise.",
  "GET /v1/events": "text/event-stream, held open indefinitely. Same reason as the per-message stream.",
  "POST /v1/confirm":
    "Takes a confirmation token, not a key, and is redeemed from the page a recipient clicks. The client is built around an API key.",
  "POST /v1/unsubscribe":
    "Takes an unsubscribe token, not a key, and is CORS-open so a domain's own page can call it from a visitor's browser.",
};

/** Every `/v1/admin` route, as one decision rather than 26 copies of it. */
const NO_SDK_ADMIN =
  "Admin keys belong to no organization and manage the whole install. The client is one organization's, and shipping operator routes in it would put an admin key in customer code.";

const key = (route: { method: string; path: string }) => `${route.method} ${route.path}`;
const isAdmin = (route: { path: string }) => route.path.startsWith("/v1/admin/");

/**
 * Routes the SDK actually calls, recorded off a client driven with a stub `fetch`. Every id passed
 * in is the spec's own parameter name, so a recorded pathname reads back as the spec path verbatim
 * — a renamed route, or a mistyped path in the SDK, shows up as a missing route rather than
 * passing silently.
 */
async function calledRoutes(): Promise<Set<string>> {
  const called = new Set<string>();
  const fetchImpl = ((input: URL, init?: RequestInit) => {
    called.add(`${init?.method ?? "GET"} ${decodeURIComponent(input.pathname)}`);
    return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  }) as unknown as typeof fetch;

  const sdk = new PouchClient({ apiKey: "sk_test_coverage", baseUrl: "https://api.example.test", fetch: fetchImpl });
  const address = { address: "ada@example.com" };

  await Promise.all([
    sdk.emails.send({ from: "hi@example.com", to: address.address, subject: "hi", text: "hi" }),
    sdk.emails.list(),
    sdk.emails.get(":id"),
    sdk.emails.resend(":id"),

    sdk.domains.create({ name: "example.com" }),
    sdk.domains.list(),
    sdk.domains.get(":id"),
    sdk.domains.update(":id", { bulk_allowed: true }),
    sdk.domains.verify(":id"),
    sdk.domains.delete(":id"),
    sdk.domains.inbound(":id"),
    sdk.domains.updateInbound(":id", { enabled: true }),
    sdk.domains.dmarcReports(":id"),
    sdk.domains.unsubscribe(":id", address),

    sdk.inbound.list(),
    sdk.inbound.get(":id"),

    sdk.addresses.create({ domain_id: "dom_1", expires_in: 3600 }),
    sdk.addresses.list(),
    sdk.addresses.get(":id"),
    sdk.addresses.update(":id", { expires_in: 3600 }),
    sdk.addresses.delete(":id"),
    sdk.addresses.messages(":id"),
    sdk.addresses.reply(":id", { message_id: "inb_1", text: "Thanks" }),
    sdk.addresses.forwardTargets.add(":id", { email: "me@example.net" }),
    sdk.addresses.forwardTargets.list(":id"),
    sdk.addresses.forwardTargets.get(":id", ":targetId"),
    sdk.addresses.forwardTargets.remove(":id", ":targetId"),
    sdk.addresses.forwardTargets.resendConfirmation(":id", ":targetId"),

    sdk.providers.list(),
    sdk.providers.get(":id"),

    sdk.reputation.get(),
    sdk.stats.get(),

    sdk.exports.create({ kind: "log_csv" }),
    sdk.exports.list(),
    sdk.exports.get(":id"),

    sdk.suppressions.import({ suppressions: [address] }),
    sdk.suppressions.list(),
    sdk.suppressions.get(":address"),
    sdk.suppressions.remove(":address"),
    sdk.recipients.get(":address"),

    sdk.lists.create({ domain_id: "dom_1", name: "Product news" }),
    sdk.lists.list(),
    sdk.lists.get(":id"),
    sdk.lists.update(":id", { name: "Product news" }),
    sdk.lists.delete(":id"),
    sdk.lists.exportCsv(":id"),
    sdk.lists.unsubscribe(":id", address),
    sdk.lists.members.add(":id", address),
    sdk.lists.members.import(":id", { members: [address] }),
    sdk.lists.members.list(":id"),
    sdk.lists.members.update(":id", ":memberId", { attributes: {} }),
    sdk.lists.members.remove(":id", ":memberId"),

    sdk.batches.send({ from: "hi@example.com", subject: "hi", text: "hi", list: "lst_1" }),
    sdk.batches.get(":id"),

    sdk.keys.create({ name: "worker" }),
    sdk.keys.list(),
    sdk.keys.get(":id"),
    sdk.keys.update(":id", { name: "worker" }),
    sdk.keys.delete(":id"),

    sdk.webhookEndpoints.create({ key_id: "key_1", url: "https://example.com/hook", events: ["email.delivered"] }),
    sdk.webhookEndpoints.list(),
    sdk.webhookEndpoints.get(":id"),
    sdk.webhookEndpoints.update(":id", { disabled: true }),
    sdk.webhookEndpoints.delete(":id"),
    sdk.webhookEndpoints.rotateSecret(":id"),
    sdk.webhookEndpoints.deliveries.list(":id"),
    sdk.webhookEndpoints.deliveries.get(":id", ":deliveryId"),

    sdk.activity.list(),
    sdk.activity.get(":id"),

    sdk.organization.get(),
    sdk.organization.update({ name: "Acme" }),
  ]);

  return called;
}

describe("the SDK covers the API", () => {
  it("has a method for every documented route outside NO_SDK and /v1/admin", async () => {
    const covered = await calledRoutes();
    const missing = ROUTES.filter((route) => !isAdmin(route))
      .map(key)
      .filter((route) => !covered.has(route) && !(route in NO_SDK));
    expect(missing).toEqual([]);
  });

  it("lists only documented, uncovered routes in NO_SDK", async () => {
    const covered = await calledRoutes();
    const documented = new Set(ROUTES.map(key));
    const stale = Object.keys(NO_SDK).filter((route) => !documented.has(route) || covered.has(route));
    expect(stale).toEqual([]);
  });

  it("calls nothing the spec doesn't document", async () => {
    const covered = await calledRoutes();
    const documented = new Set(ROUTES.map(key));
    expect([...covered].filter((route) => !documented.has(route))).toEqual([]);
  });

  it("leaves out every admin route and nothing else under NO_SDK_ADMIN", async () => {
    const covered = await calledRoutes();
    const admin = ROUTES.filter(isAdmin);
    expect(admin.length).toBeGreaterThan(0);
    expect(admin.map(key).filter((route) => covered.has(route))).toEqual([]);
    expect(ROUTES.filter((route) => route.auth === "Admin key" && !isAdmin(route)).map(key)).toEqual([]);
    expect(NO_SDK_ADMIN).toMatch(/\S/);
  });

  it("excludes only streams and token routes, apart from admin", async () => {
    const keyed = ROUTES.filter((route) => route.auth.startsWith("Bearer key") && key(route) in NO_SDK).map(key);
    expect(keyed).toEqual(["GET /v1/emails/:id/events", "GET /v1/events"]);
  });
});

describe("SDK error codes", () => {
  it("name every code the API can return", () => {
    // Fails typecheck when the API gains a code the SDK's union doesn't list as known.
    const covered: [Exclude<ErrorCode, KnownPouchErrorCode>] extends [never] ? true : false = true;
    expect(covered).toBe(true);
  });
});
