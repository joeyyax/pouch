import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ApiKeyRow } from "@/lib/api/keys";
import { withAnyKey } from "@/lib/api/with-key";
import { buildMcpServer } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";

/**
 * The MCP endpoint: one streamable HTTP transport per request, stateless. `withAnyKey` gives
 * it the exact auth, rate-limiting and X-Request-Id handling every `/v1` route gets — this
 * isn't a second auth system, it's the same one. The key's own `Authorization` header is
 * forwarded to every tool call this connection makes (lib/mcp/invoke.ts), so each call
 * re-authenticates and re-scopes through the route it wraps, the same as any other caller of
 * that route would.
 *
 * Stateless mode (`sessionIdGenerator: undefined`) matches what the tools actually do: nothing
 * here keeps session state between calls, since a tool call is a single pass-through request.
 * `enableJsonResponse` avoids holding an SSE stream open for what's normally a fast round trip
 * to an already-fast /v1 route.
 */
async function handle(request: Request, key: ApiKeyRow): Promise<Response> {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    // withAnyKey already required this to authenticate; this only satisfies the type.
    return new Response("unreachable", { status: 500 });
  }

  const server = buildMcpServer(key, authorization);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}

export const POST = withAnyKey(handle);
export const GET = withAnyKey(handle);
export const DELETE = withAnyKey(handle);
