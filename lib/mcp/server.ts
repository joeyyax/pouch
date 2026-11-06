import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiKeyRow } from "@/lib/api/keys";
import { WIRE_TOKEN } from "@/lib/wire";
import { MCP_TOOLS } from "./registry";
import { invokeTool, toCallToolResult } from "./invoke";
import { invokeWatchTool, watchTimeoutMs } from "./watch";

/**
 * The scope sentence every tool description carries. A key's `domainIds` already constrains
 * every route behind these tools — `list_domains` only ever returns the key's domains,
 * `create_domain`/provider routes 403 a scoped key outright (lib/domains/index.ts,
 * lib/api/keys.ts's keyCanAccessDomain) — this just states that truth in the tool list itself,
 * so a caller isn't left assuming a tool reaches more than this key can reach.
 */
function scopeSentence(key: ApiKeyRow): string {
  if (key.domainIds.length === 0) return "This key isn't domain-scoped: it can reach every domain in the organization.";
  return `This key is scoped to ${key.domainIds.length} domain${key.domainIds.length === 1 ? "" : "s"}: ${key.domainIds.join(", ")}.`;
}

/** True for a route docs/api/conventions.md restricts to "a key with no domain scope". */
function requiresUnscopedKey(auth: string): boolean {
  return auth.includes("no domain scope");
}

/**
 * Builds one MCP server per request, scoped to the key that authenticated it. Every tool is
 * generated from `lib/mcp/registry.ts`'s pairing of a route spec (from the #4/#61 docs
 * generator) and that route's own zod schema — nothing here hand-describes a field or a rule.
 * `authorization` is the raw `Bearer <key>` header value the caller sent to POST /mcp; it's
 * forwarded unchanged to every route call a tool makes, so the route re-authenticates the same
 * key and applies the same scoping a direct HTTP caller would get.
 */
export function buildMcpServer(key: ApiKeyRow, authorization: string): McpServer {
  const server = new McpServer({ name: WIRE_TOKEN, version: "1.0.0" }, { capabilities: { tools: {} } });
  const scope = scopeSentence(key);

  for (const tool of MCP_TOOLS) {
    if (tool.admin && key.scope !== "admin") continue;
    const { route } = tool;
    const restriction = requiresUnscopedKey(route.auth) ? ` Requires a key with no domain scope — ${route.auth.toLowerCase()}.` : "";
    // The underlying route streams SSE; a tool call can't return a completed result until the
    // stream does, so its description describes what the tool itself hands back rather than the
    // route.response wording the docs page uses, which is written for a caller that stays
    // connected.
    const responseDescription = tool.stream
      ? `Blocks until the message reaches a terminal state (delivered, bounced, complained or failed) or ${Math.round(watchTimeoutMs() / 1000)}s elapses, whichever comes first, then returns { finished, message, events }. finished is false when the timeout won — that's not a failure, call it again with the same id to keep watching. message is the message in the same shape GET /v1/emails/:id returns; events lists the transitions seen during this call.`
      : route.response.description;
    const description = [
      `${route.method} ${route.path}. ${responseDescription}`,
      scope,
      restriction,
      `Errors: ${route.errors.join(", ")}.`,
    ]
      .filter(Boolean)
      .join(" ");

    server.registerTool(
      tool.name,
      { title: route.summary, description, inputSchema: tool.inputSchema, annotations: tool.annotations },
      async (args) => {
        if (tool.stream) return invokeWatchTool(tool, authorization, (args ?? {}) as Record<string, unknown>);
        const response = await invokeTool(tool, authorization, (args ?? {}) as Record<string, unknown>);
        return toCallToolResult(response);
      },
    );
  }

  return server;
}
