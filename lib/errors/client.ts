const reported = new WeakSet<object>();

/** The first `depth` path segments, so a token deeper in the URL never leaves the browser. */
function routeOf(pathname: string, depth: number | undefined): string {
  if (depth === undefined) return pathname;
  return `/${pathname.split("/").filter(Boolean).slice(0, depth).join("/")}`;
}

/**
 * Sends a render error to `/client-errors`, once per error object. A digest when Next supplied
 * one, otherwise the message. Never throws. `routeDepth` trims the route for a boundary that can
 * sit on a page whose path carries a token.
 */
export function reportClientError(error: Error & { digest?: string }, routeDepth?: number): void {
  if (reported.has(error)) return;
  reported.add(error);

  const body = JSON.stringify({
    route: routeOf(window.location.pathname, routeDepth),
    ...(error.digest ? { digest: error.digest } : { message: String(error.message).slice(0, 300) }),
  });
  fetch("/client-errors", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
}
