import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { REQUEST_ID_HEADER } from "@/lib/api/request-id";
import type { McpToolDefinition } from "./registry";

/** Base the constructed Request's URL on. Never dereferenced — routes only read path and query. */
const INTERNAL_ORIGIN = "http://mcp.internal";

function queryValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Builds the same Request the HTTP route would have received, and calls the route's exported
 * handler directly, in-process. This is the entire wrapper: no field is read, validated or
 * transformed here that the route wouldn't already read, validate or transform itself. `args`
 * has already been parsed against `tool.inputSchema` — the same zod schema the route parses
 * with — by the MCP SDK before this runs. `signal`, when given, becomes the constructed
 * Request's own — a route that already aborts on its request signal (both SSE routes do) reacts
 * to it exactly as it would a client disconnecting.
 */
export async function invokeTool(
  tool: McpToolDefinition,
  authorization: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  let path = tool.route.path;
  for (const param of tool.pathParams) {
    path = path.replace(`:${param}`, encodeURIComponent(String(args[param])));
  }

  const url = new URL(path, INTERNAL_ORIGIN);
  const headers = new Headers({ authorization });
  const init: RequestInit = { method: tool.route.method, headers, ...(signal ? { signal } : {}) };

  const rest = Object.fromEntries(Object.entries(args).filter(([key]) => !tool.pathParams.includes(key)));

  if (tool.payload === "query") {
    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined) continue;
      url.searchParams.set(key, queryValue(value));
    }
  } else if (tool.payload === "body") {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(rest);
  }

  const context =
    tool.pathParams.length > 0
      ? { params: Promise.resolve(Object.fromEntries(tool.pathParams.map((p) => [p, String(args[p])]))) }
      : undefined;

  return tool.handler(new Request(url, init), context);
}

/**
 * Turns the route's Response into an MCP CallToolResult. A 2xx body becomes the tool's
 * structured result, verbatim. A non-2xx body is already `docs/api/conventions.md`'s error
 * envelope — `{ error: { code, message, field, detail, request_id } }` — and is carried
 * through unchanged as the tool's error result, so a caller sees exactly what an HTTP caller
 * of the same route would have seen, just inside MCP's error shape instead of a status code.
 */
export async function toCallToolResult(response: Response): Promise<CallToolResult> {
  const requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const _meta = requestId ? { request_id: requestId } : undefined;

  // A non-JSON success (the list CSV export) is returned as text, verbatim.
  if (response.ok && !contentType.includes("application/json")) {
    return { isError: false, content: [{ type: "text", text }], _meta: { ..._meta, content_type: contentType } };
  }

  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = { error: { code: "provider_unavailable", message: "The route returned a non-JSON response." } };
  }

  const isError = response.status >= 400;
  return {
    isError,
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    ...(isError ? {} : { structuredContent: body as Record<string, unknown> }),
    _meta,
  };
}
