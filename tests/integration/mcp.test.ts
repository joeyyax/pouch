import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { POST } from "@/app/mcp/route";
import { db } from "@/lib/db";
import { messages } from "@/lib/db/schema";
import type { MessageStatus } from "@/lib/db/schema";
import { createApiKey } from "@/lib/api/key-lifecycle";
import { acquireStreamSlot, maxConcurrentStreams } from "@/lib/api/rate-limit";
import { recordEvent } from "@/lib/messages/events";
import { closeRedis, redis } from "@/lib/redis";
import { addressMailChannel } from "@/lib/addresses/inbox";
import { MCP_TOOLS } from "@/lib/mcp/registry";
import { seedAdmin } from "./admin-fixtures";
import { addDomainKey, resetDatabase, seedFixture, seedMessage as seedFixtureMessage, type Fixture } from "./fixtures";
import { testRedisUrl } from "../redis";

const REDIS_URL = testRedisUrl();

// Real example.com publishes adkim=s; the DNS check has its own tests.
vi.mock("@/lib/addresses/alignment", () => ({ requiresStrictDkim: () => Promise.resolve(false) }));

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { type?: string };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: {
    tools?: McpTool[];
    isError?: boolean;
    content?: { type: string; text: string }[];
    structuredContent?: unknown;
  };
  error?: { code: number; message: string };
}

function initHeaders(secret: string): HeadersInit {
  return {
    authorization: `Bearer ${secret}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
}

async function callMcp(secret: string, body: unknown): Promise<JsonRpcResponse> {
  const response = await POST(
    new Request("http://mcp.test/mcp", { method: "POST", headers: initHeaders(secret), body: JSON.stringify(body) }),
  );
  return (await response.json()) as JsonRpcResponse;
}

function callTool(secret: string, name: string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
  return callMcp(secret, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
}

/** A tool result's structured API error body, the same envelope docs/api/conventions.md defines. */
function toolError(result: JsonRpcResponse["result"]): { code: string; message: string } {
  const text = result?.content?.[0]?.text;
  if (!text) throw new Error("no tool content");
  return (JSON.parse(text) as { error: { code: string; message: string } }).error;
}

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture({ scopeToDomain: false });
});

describe("POST /mcp", () => {
  it("lists every registered tool with a name, description and input schema, no name twice", async () => {
    const response = await callMcp(fixture.secret, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = response.result?.tools ?? [];
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of tools) {
      expect(tool.name, "name").toBeTruthy();
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema?.type, tool.name).toBe("object");
    }
    expect(names.sort()).toEqual(MCP_TOOLS.filter((t) => !t.admin).map((t) => t.name).sort());
  });

  it("marks what removes or replaces something destructive, and every GET read-only", async () => {
    const response = await callMcp(fixture.secret, { jsonrpc: "2.0", id: 7, method: "tools/list" });
    const tools = response.result?.tools ?? [];
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));

    const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort();
    expect(destructive).toEqual(
      [
        "delete_domain",
        "delete_list",
        "delete_webhook_endpoint",
        "remove_forward_target",
        "remove_list_member",
        "remove_suppression",
        "revoke_address",
        "revoke_key",
        "rotate_webhook_secret",
        "unsubscribe_from_domain",
        "unsubscribe_from_list",
        "update_domain_inbound",
      ].sort(),
    );

    const readOnly = [
      "list_domains",
      "read_domain",
      "list_emails",
      "read_email",
      "watch_email",
      "list_providers",
      "read_provider",
      "list_exports",
      "read_export",
      "read_reputation",
      "list_suppressions",
      "read_suppression",
      "list_lists",
      "read_list",
      "list_list_members",
      "export_list_members",
      "read_batch",
      "list_inbound",
      "read_inbound",
      "read_domain_inbound",
      "list_addresses",
      "read_address",
      "list_keys",
      "read_key",
      "list_webhook_endpoints",
      "read_webhook_endpoint",
      "read_organization",
    ];
    for (const name of readOnly) {
      expect(byName.get(name)?.readOnlyHint, name).toBe(true);
      expect(byName.get(name)?.destructiveHint, name).toBe(false);
    }
  });

  it("returns the list CSV export as text through the same code path GET /v1/lists/:id/export uses", async () => {
    const created = await callTool(fixture.secret, "create_list", { domain_id: fixture.domainId, name: "News", double_opt_in: false });
    expect(created.result?.isError).toBe(false);
    const listId = (created.result?.structuredContent as { id: string }).id;

    const added = await callTool(fixture.secret, "add_list_member", { id: listId, address: "ada@EXAMPLE.com" });
    expect(added.result?.isError).toBe(false);

    const exported = await callTool(fixture.secret, "export_list_members", { id: listId });
    expect(exported.result?.isError).toBe(false);
    expect(exported.result?.structuredContent).toBeUndefined();
    const csv = exported.result?.content?.[0]?.text ?? "";
    expect(csv.split("\n")[0]).toContain("address");
    expect(csv).toContain("ada@example.com");
  });

  it.each<[string, string, (listId: string, f: Fixture) => Record<string, unknown>]>([
    ["read_list", "GET /v1/lists/:id", (listId) => ({ id: listId })],
    ["read_domain", "GET /v1/domains/:id", (_, f) => ({ id: f.domainId })],
    ["create_domain", "POST /v1/domains", (_, f) => ({ name: "third.example.com", provider_id: f.providerId })],
    ["delete_domain", "DELETE /v1/domains/:id", (_, f) => ({ id: f.domainId })],
  ])("refuses %s for a key scoped elsewhere, the same as %s", async (tool, _route, args) => {
    const created = await callTool(fixture.secret, "create_list", { domain_id: fixture.domainId, name: "News" });
    const listId = (created.result?.structuredContent as { id: string }).id;
    const other = await addDomainKey(fixture, "second.example.com");

    const response = await callTool(other.secret, tool, args(listId, fixture));
    expect(response.result?.isError).toBe(true);
    expect(toolError(response.result)).toMatchObject({ code: "key_not_scoped" });
  });

  it("calls list_domains through the same code path GET /v1/domains uses", async () => {
    const response = await callMcp(fixture.secret, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_domains", arguments: {} },
    });
    expect(response.result?.isError).toBe(false);
    const body = response.result?.structuredContent as { data: { id: string }[] };
    expect(body.data.map((d) => d.id)).toEqual([fixture.domainId]);
  });

  it("imports and lists suppressions through the same code path /v1/suppressions uses", async () => {
    const imported = await callMcp(fixture.secret, {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "import_suppressions",
        arguments: { suppressions: [{ address: "ada@EXAMPLE.com" }, { address: "nope" }], reason: "complaint", source: "postmark" },
      },
    });
    expect(imported.result?.isError).toBe(false);
    expect(imported.result?.structuredContent).toMatchObject({ added: 1, already_present: 0, invalid: 1 });

    const listed = await callMcp(fixture.secret, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "list_suppressions", arguments: { reason: "complaint" } },
    });
    const body = listed.result?.structuredContent as { data: { address: string; source: string }[] };
    expect(body.data).toEqual([expect.objectContaining({ address: "ada@example.com", source: "postmark" })]);
  });

  it("never returns a domain outside the key's scope from list_domains", async () => {
    const other = await addDomainKey(fixture, "second.example.com");
    const response = await callMcp(other.secret, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "list_domains", arguments: {} },
    });
    const body = response.result?.structuredContent as { data: { id: string }[] };
    expect(body.data.map((d) => d.id)).toEqual([other.domainId]);
    expect(body.data.map((d) => d.id)).not.toContain(fixture.domainId);
  });

  it("calls delete_domain through the same code path DELETE /v1/domains/:id uses", async () => {
    const other = await addDomainKey(fixture, "second.example.com");
    const response = await callMcp(fixture.secret, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "delete_domain", arguments: { id: other.domainId } },
    });
    expect(response.result?.isError).toBe(false);
    expect(response.result?.structuredContent).toMatchObject({ id: other.domainId, deleted: true });
  });

  it("offers no provider write tools, and refuses a call to one", async () => {
    const listed = await callMcp(fixture.secret, { jsonrpc: "2.0", id: 10, method: "tools/list" });
    const providerTools = (listed.result?.tools ?? []).map((t) => t.name).filter((name) => name.includes("provider"));
    expect(providerTools.sort()).toEqual(["list_providers", "read_provider"]);

    for (const name of ["create_provider", "update_provider", "test_provider", "delete_provider"]) {
      const response = await callTool(fixture.secret, name, { id: fixture.providerId, adapter: "mock", name: "x", credentials: {} });
      const refused = response.error !== undefined || response.result?.isError === true;
      expect(refused, name).toBe(true);
    }
  });

  it("reads a provider with no settings or credentials", async () => {
    const response = await callTool(fixture.secret, "read_provider", { id: fixture.providerId });
    expect(response.result?.isError).toBe(false);
    expect(response.result?.structuredContent).toMatchObject({ id: fixture.providerId });
    expect(response.result?.structuredContent).not.toHaveProperty("settings");
    expect(JSON.stringify(response)).not.toContain("test-token");
  });

  it("rejects an unknown or missing key the same way /v1 does", async () => {
    const response = await POST(
      new Request("http://mcp.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/list" }),
      }),
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_key");
  });
});

const ADMIN_TOOL_NAMES = [
  "adopt_admin_domain",
  "list_admin_providers",
  "read_admin_provider",
  "create_admin_provider",
  "update_admin_provider",
  "test_admin_provider",
  "setup_admin_provider",
  "read_admin_conversion",
  "convert_admin_provider",
  "delete_admin_provider",
  "list_provider_organizations",
  "assign_organization",
  "unassign_organization",
  "list_admin_organizations",
  "read_admin_organization",
  "update_admin_organization",
  "suspend_organization",
  "release_organization",
  "create_admin_organization",
  "delete_admin_organization",
  "list_organization_members",
  "update_organization_member",
  "remove_organization_member",
  "invite_to_organization",
  "list_organization_invitations",
  "revoke_organization_invitation",
  "resend_organization_invitation",
  "list_admin_users",
  "read_admin_user",
  "update_admin_user",
  "delete_admin_user",
].sort();

describe("admin tools", () => {
  it("are listed to an admin key alongside the ordinary tools", async () => {
    const admin = await seedAdmin();
    const response = await callMcp(admin.secret, { jsonrpc: "2.0", id: 20, method: "tools/list" });
    const names = (response.result?.tools ?? []).map((t) => t.name);
    expect(names.filter((name) => ADMIN_TOOL_NAMES.includes(name)).sort()).toEqual(ADMIN_TOOL_NAMES);
    expect(names).toContain("send_email");
    expect(names).toHaveLength(MCP_TOOLS.length);
  });

  it("are never listed to an organization key, unscoped or scoped", async () => {
    expect(MCP_TOOLS.filter((t) => t.admin).map((t) => t.name).sort()).toEqual(ADMIN_TOOL_NAMES);
    const admin = await seedAdmin();
    const { secret: otherKey } = await createApiKey({ organizationId: admin.organizationId, name: "plain", mode: "live", domainIds: [] });
    const scoped = await addDomainKey(fixture);
    for (const secret of [fixture.secret, scoped.secret, otherKey]) {
      const response = await callMcp(secret, { jsonrpc: "2.0", id: 21, method: "tools/list" });
      const names = (response.result?.tools ?? []).map((t) => t.name);
      expect(names.length).toBeGreaterThan(0);
      expect(names.filter((name) => ADMIN_TOOL_NAMES.includes(name))).toEqual([]);
    }
  });

  it("can't be called with an organization key even though the name is known", async () => {
    expect(MCP_TOOLS.filter((t) => t.admin).map((t) => t.name).sort()).toEqual(ADMIN_TOOL_NAMES);
    for (const name of ADMIN_TOOL_NAMES) {
      const response = await callTool(fixture.secret, name, { id: fixture.providerId });
      expect(response.error !== undefined || response.result?.isError === true, name).toBe(true);
      expect(JSON.stringify(response), name).not.toContain('"data"');
    }
  });

  it("marks deletes, unassignment, suspension and conversion destructive, reads read-only, and repeatable writes idempotent", async () => {
    const admin = await seedAdmin();
    const response = await callMcp(admin.secret, { jsonrpc: "2.0", id: 22, method: "tools/list" });
    const byName = new Map((response.result?.tools ?? []).map((t) => [t.name, t.annotations]));
    const admins = ADMIN_TOOL_NAMES.map((name) => ({ name, ...byName.get(name) }));

    expect(admins.filter((t) => t.destructiveHint).map((t) => t.name).sort()).toEqual(
      [
        "convert_admin_provider",
        "delete_admin_organization",
        "delete_admin_provider",
        "delete_admin_user",
        "remove_organization_member",
        "resend_organization_invitation",
        "revoke_organization_invitation",
        "suspend_organization",
        "unassign_organization",
        "update_admin_user",
      ].sort(),
    );
    expect(admins.filter((t) => t.readOnlyHint).map((t) => t.name).sort()).toEqual(
      [
        "list_admin_providers",
        "list_organization_invitations",
        "read_admin_provider",
        "test_admin_provider",
        "read_admin_conversion",
        "list_provider_organizations",
        "list_admin_organizations",
        "read_admin_organization",
        "list_admin_users",
        "read_admin_user",
        "list_organization_members",
      ].sort(),
    );
    for (const name of [
      "update_admin_provider",
      "setup_admin_provider",
      "release_organization",
      "assign_organization",
      "update_admin_organization",
      "update_organization_member",
    ]) {
      expect(byName.get(name)?.idempotentHint, name).toBe(true);
      expect(byName.get(name)?.destructiveHint, name).toBe(false);
    }
    expect(byName.get("create_admin_provider")?.idempotentHint).toBe(false);
    expect(byName.get("create_admin_organization")?.idempotentHint).toBe(false);
  });

  it("calls an admin route through /mcp with an admin key", async () => {
    const admin = await seedAdmin();
    const response = await callTool(admin.secret, "read_admin_organization", { id: fixture.organizationId });
    expect(response.result?.isError).toBe(false);
    expect(response.result?.structuredContent).toMatchObject({ id: fixture.organizationId, assignment_count: 1, domain_count: 1 });
  });
});

/** Inserts a message row directly, mirroring tests/integration/message-events-stream.test.ts. */
async function seedMessage(organizationId: string, domainId: string, status: MessageStatus = "queued"): Promise<string> {
  return seedFixtureMessage({ organizationId, domainId }, { status, to: "sam@example.com", subject: "Hello" });
}

async function addTransition(organizationId: string, messageId: string, status: MessageStatus, occurredAt = new Date()): Promise<string> {
  const eventId = await recordEvent({ organizationId, messageId, status, occurredAt });
  if (!eventId) throw new Error("expected a new event row");
  return eventId;
}

describe("watch_email", () => {
  it("returns the terminal message and its transitions without needing Redis", async () => {
    const messageId = await seedMessage(fixture.organizationId, fixture.domainId, "queued");
    await addTransition(fixture.organizationId, messageId, "queued", new Date(Date.now() - 2000));
    await addTransition(fixture.organizationId, messageId, "sent", new Date(Date.now() - 1000));
    await addTransition(fixture.organizationId, messageId, "delivered", new Date());
    await db.update(messages).set({ status: "delivered", deliveredAt: new Date() }).where(eq(messages.id, messageId));

    const response = await callMcp(fixture.secret, {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "watch_email", arguments: { id: messageId } },
    });

    expect(response.result?.isError).toBe(false);
    const body = response.result?.structuredContent as { finished: boolean; message: { id: string; status: string }; events: { type: string }[] };
    expect(body.finished).toBe(true);
    expect(body.message.id).toBe(messageId);
    expect(body.message.status).toBe("delivered");
    expect(body.events.map((e) => e.type)).toEqual(["email.queued", "email.sent", "email.delivered"]);
  });

  it("relays key_not_scoped for a message outside the key's domains, the same as GET /v1/emails/:id/events", async () => {
    const other = await addDomainKey(fixture, "other.example.com");
    const messageId = await seedMessage(fixture.organizationId, fixture.domainId, "delivered");
    await addTransition(fixture.organizationId, messageId, "delivered", new Date());

    const response = await callMcp(other.secret, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "watch_email", arguments: { id: messageId } },
    });

    expect(response.result?.isError).toBe(true);
    expect(toolError(response.result)).toMatchObject({ code: "key_not_scoped" });
  });

  describe("with a live message and Redis available", () => {
    beforeEach(async () => {
      process.env.REDIS_URL = REDIS_URL;
      await closeRedis();
    });

    afterEach(async () => {
      delete process.env.MCP_WATCH_TIMEOUT_MS;
      delete process.env.REDIS_URL;
      await closeRedis();
    });

    it("returns unfinished, not an error, once its own timeout elapses on a message stuck queued", async () => {
      process.env.MCP_WATCH_TIMEOUT_MS = "300";
      const messageId = await seedMessage(fixture.organizationId, fixture.domainId, "queued");
      await addTransition(fixture.organizationId, messageId, "queued", new Date());

      const started = Date.now();
      const response = await callMcp(fixture.secret, {
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: { name: "watch_email", arguments: { id: messageId } },
      });
      const elapsedMs = Date.now() - started;

      expect(response.result?.isError).toBe(false);
      expect(elapsedMs).toBeLessThan(3000);
      const body = response.result?.structuredContent as { finished: boolean; message: { status: string } };
      expect(body.finished).toBe(false);
      expect(body.message.status).toBe("queued");
      const text = response.result?.content?.[0]?.text ?? "";
      expect(text).toContain("watch_email again");
    });

    it("counts a held watch_email call against the key's concurrent-stream ceiling", async () => {
      const limit = maxConcurrentStreams();
      const slots = [];
      for (let i = 0; i < limit; i += 1) {
        const outcome = await acquireStreamSlot(fixture.key.id, limit);
        if (!outcome.ok) throw new Error("expected a free slot while filling the ceiling");
        slots.push(outcome.slot);
      }

      const messageId = await seedMessage(fixture.organizationId, fixture.domainId, "queued");
      await addTransition(fixture.organizationId, messageId, "queued", new Date());

      const response = await callMcp(fixture.secret, {
        jsonrpc: "2.0",
        id: 23,
        method: "tools/call",
        params: { name: "watch_email", arguments: { id: messageId } },
      });

      expect(response.result?.isError).toBe(true);
      expect(toolError(response.result)).toMatchObject({ code: "stream_limit_exceeded" });

      for (const slot of slots) await slot.release();
    });
  });
});

describe("address tools", () => {
  beforeEach(async () => {
    process.env.REDIS_URL = REDIS_URL;
    await closeRedis();
  });

  afterEach(async () => {
    delete process.env.REDIS_URL;
    await closeRedis();
  });

  it("creates an address, waits for its mail, and replies from it", async () => {
    const { domains } = await import("@/lib/db/schema");
    const { ingestInboundMessages } = await import("@/lib/inbound/ingest");
    await db.update(domains).set({ inboundEnabled: true }).where(eq(domains.id, fixture.domainId));

    const created = await callTool(fixture.secret, "create_address", { domain_id: fixture.domainId, expires_in: 600 });
    const address = created.result?.structuredContent as { id: string; address: string };

    const [domain] = await db.select().from(domains).where(eq(domains.id, fixture.domainId));
    const pending = callTool(fixture.secret, "wait_for_mail", { id: address.id, wait: 10 });
    await vi.waitFor(async () => {
      const [, count] = (await redis()!.pubsub("NUMSUB", addressMailChannel(fixture.organizationId))) as [string, number];
      expect(Number(count)).toBe(1);
    });
    await ingestInboundMessages(domain!, [
      {
        providerMessageId: "p-mcp",
        from: { name: null, address: "ada@example.net" },
        to: [address.address],
        subject: "Your code is 4821",
        text: "4821",
        html: null,
        headers: {},
        messageId: "<code@example.net>",
        inReplyTo: null,
        attachments: [],
        raw: null,
        verdicts: null,
      },
    ]);
    const arrived = (await pending).result?.structuredContent as { data: { id: string; subject: string }[] };
    expect(arrived.data.map((m) => m.subject)).toEqual(["Your code is 4821"]);

    const replied = await callTool(fixture.secret, "reply_from_address", { id: address.id, message_id: arrived.data[0]!.id, text: "Thanks" });
    expect(replied.result?.isError).toBe(false);
    expect((replied.result?.structuredContent as { status: string }).status).toBe("queued");
  });
});
