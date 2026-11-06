import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ResolvedTarget } from "./ssrf";

/** No redirect is ever followed — a 3xx is just another non-2xx to retry or exhaust. */
export const REQUEST_TIMEOUT_MS = 10_000;

export interface DeliveryAttemptResult {
  statusCode: number | null;
  error: string | null;
  durationMs: number;
}

/**
 * POSTs to the resolved address directly — never to `target.hostname` again — so the connection
 * lands where the SSRF guard just checked, with `Host` and SNI set to the original hostname for
 * routing and certificate validation.
 */
export function postSigned(target: ResolvedTarget, body: string, headers: Record<string, string>): Promise<DeliveryAttemptResult> {
  const start = Date.now();
  const requester = target.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve) => {
    let settled = false;
    const done = (result: DeliveryAttemptResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = requester(
      {
        host: target.address,
        port: target.port,
        path: target.path || "/",
        method: "POST",
        servername: target.protocol === "https:" ? target.hostname : undefined,
        headers: { ...headers, Host: target.hostname, "Content-Length": Buffer.byteLength(body) },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        res.on("end", () => done({ statusCode: res.statusCode ?? null, error: null, durationMs: Date.now() - start }));
      },
    );

    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", (err) => done({ statusCode: null, error: (err as Error).message, durationMs: Date.now() - start }));
    req.write(body);
    req.end();
  });
}
