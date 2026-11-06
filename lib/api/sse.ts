/** Headers common to every held-open `/v1` stream. */
export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Tells a buffering proxy to pass each chunk through as it arrives.
  "x-accel-buffering": "no",
};

/** One SSE frame. `id` is what a reconnect echoes back as `Last-Event-ID`. */
export function sseFrame(data: unknown, options: { id?: string; event?: string } = {}): string {
  const lines: string[] = [];
  if (options.id) lines.push(`id: ${options.id}`);
  if (options.event) lines.push(`event: ${options.event}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return `${lines.join("\n")}\n\n`;
}

/** A comment line: invisible to `EventSource`, enough to keep an idle proxy from closing the connection. */
export function sseComment(text: string): string {
  return `: ${text}\n\n`;
}
