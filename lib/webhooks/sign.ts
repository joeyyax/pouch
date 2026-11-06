import { createHmac } from "node:crypto";

/** The exact string a receiver reconstructs and signs to check `X-Signature`. */
export function signedString(timestamp: number, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/** `sha256=<hex>` HMAC-SHA256 of `signedString`, keyed by the endpoint's secret. */
export function sign(secret: string, timestamp: number, rawBody: string): string {
  const digest = createHmac("sha256", secret).update(signedString(timestamp, rawBody)).digest("hex");
  return `sha256=${digest}`;
}
