import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { REQUEST_ID_HEADER } from "@/lib/api/request-id";
import { isTerminal } from "@/lib/messages/lifecycle";
import type { StreamFrame } from "@/lib/messages/stream";
import { invokeTool, toCallToolResult } from "./invoke";
import type { McpToolDefinition } from "./registry";

/**
 * How long `watch_email` blocks before returning whatever it has. A tool call has no
 * `Last-Event-ID` to reconnect with the way an HTTP caller of the same route does, so a bound
 * here is what keeps a message stuck in `queued` from holding the call open indefinitely. Kept
 * under 60s, the tool-call timeout common to MCP clients, so a caller sees this tool's own
 * "not finished yet" result rather than its transport aborting the call first. A setting, not a
 * hardcode, per docs/decisions.md's "defaults follow convention" rule.
 */
export function watchTimeoutMs(): number {
  return Number(process.env.MCP_WATCH_TIMEOUT_MS ?? "55000");
}

/** One line of a parsed SSE frame's `data:` field. Comment and heartbeat lines carry no `data:` and are skipped. */
function parseSseFrames(buffer: string): { frames: StreamFrame[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const frames: StreamFrame[] = [];
  for (const part of parts) {
    const dataLine = part.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine) continue;
    try {
      frames.push(JSON.parse(dataLine.slice("data: ".length)) as StreamFrame);
    } catch {
      // A malformed frame is dropped rather than failing the whole watch.
    }
  }
  return { frames, rest };
}

/**
 * Calls a route that streams SSE (`GET /v1/emails/:id/events`) and turns it into one
 * `CallToolResult` — the shape a tool call needs, since a held-open stream has nothing to
 * return through `toCallToolResult`. The route itself still does everything that isn't
 * transport: validation, key scoping, opening the stream, holding the concurrent-stream slot,
 * and closing the connection once the message reaches a terminal state. This only reads what
 * the route already writes, and aborts the same request signal the route already listens for
 * when `watchTimeoutMs()` elapses — a timed-out watch releases its slot the same way a client
 * disconnecting would, not by holding it until the slot's own TTL expires.
 *
 * A response that never opens a stream at all — the route rejected the call outright, with
 * `not_found`, `key_not_scoped`, `stream_limit_exceeded`, or the like — falls through to the
 * same error handling every other tool gets.
 */
export async function invokeWatchTool(
  tool: McpToolDefinition,
  authorization: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const controller = new AbortController();
  const response = await invokeTool(tool, authorization, args, controller.signal);

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("text/event-stream") || !response.body) {
    return toCallToolResult(response);
  }

  const requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: { id: string; type: string; created_at: string }[] = [];
  let message: StreamFrame["data"] | null = null;
  let finished = false;

  const timer = setTimeout(() => controller.abort(), watchTimeoutMs());
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      buffer += decoder.decode(step.value, { stream: true });
      const parsed = parseSseFrames(buffer);
      buffer = parsed.rest;
      for (const frame of parsed.frames) {
        events.push({ id: frame.id, type: frame.type, created_at: frame.created_at });
        message = frame.data;
        if (isTerminal(frame.data.status)) finished = true;
      }
    }
  } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort();
  }

  const body = { finished, message, events };
  return {
    isError: false,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          finished
            ? body
            : {
                ...body,
                note: "Timed out before the message reached a terminal state. Call watch_email again with the same id to keep watching — it replays the full history, so nothing in between is missed.",
              },
          null,
          2,
        ),
      },
    ],
    structuredContent: body,
    _meta: requestId ? { request_id: requestId } : undefined,
  };
}
