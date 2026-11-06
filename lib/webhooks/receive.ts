import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { providers } from "@/lib/db/schema";
import { mergeSettings, organizationOf, adapterFor } from "@/lib/providers";
import { applyTenantStatus } from "@/lib/providers/tenant-status";
import { ApiError } from "@/lib/api/errors";
import { json } from "@/lib/api/response";
import { logger } from "@/lib/logger";
import { applyEvents } from "@/lib/messages/events";
import { receiveProviderMail } from "@/lib/inbound/ingest";
import type { SignedRequest } from "@/lib/providers/adapters/types";

const log = logger.child("webhooks");

export interface ReceiptCounts {
  applied: number;
  ignored: number;
}

/** SNS's own 256 KB message cap. Deliberately not the API's 30 MB attachment cap: this route
 * is unauthenticated, and must not buffer 30 MB per request to find out the body is junk. */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

function webhookBodyTooLarge(): ApiError {
  return new ApiError("attachment_too_large", "Request body exceeds the 256 KB limit.", {
    detail: { limit_bytes: MAX_WEBHOOK_BODY_BYTES },
  });
}

/** Reads a body to text, stopping the moment the running total crosses the cap. Content-Length
 * is checked too, but a missing or understated one must not get past the streaming check. */
async function readCappedWebhookBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_BYTES) {
    log.warn(`declared body of ${declared} bytes exceeds the ${MAX_WEBHOOK_BODY_BYTES} byte cap`);
    throw webhookBodyTooLarge();
  }

  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_WEBHOOK_BODY_BYTES) {
      log.warn(`request body crossed the ${MAX_WEBHOOK_BODY_BYTES} byte cap at ${total} bytes`);
      await reader.cancel();
      throw webhookBodyTooLarge();
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Handles one provider callback. The path names the provider, so the receiver knows the
 * organization and the credentials without scanning, and an event signed for one provider can
 * never apply to another.
 */
export async function receive(adapter: string, providerId: string, request: Request): Promise<Response> {
  // The raw bytes, before any parsing: the signature covers these and nothing else.
  const rawBody = await readCappedWebhookBody(request);

  const [provider] = await db
    .select()
    .from(providers)
    .where(and(eq(providers.id, providerId), eq(providers.adapter, adapter)))
    .limit(1);

  if (!provider) {
    // The 401 is the same envelope a known provider gets for a bad signature, so probing can't
    // distinguish an unknown id from a known one. The id still appears in the operator log.
    log.warn(`rejected a webhook for an unknown (adapter, providerId): ${adapter}/${providerId}`);
    throw new ApiError("invalid_signature", "This event isn't signed with the key on file for this provider.");
  }

  const client = adapterFor(provider);
  const signed: SignedRequest = { rawBody, headers: Object.fromEntries(request.headers) };

  if (!(await client.events.verify(signed))) {
    log.warn(`rejected an event for ${provider.id}: the signature doesn't match the provider's key`);
    throw new ApiError("invalid_signature", "This event isn't signed with the key on file for this provider.");
  }

  if (client.events.control) {
    const outcome = await client.events.control(signed);
    if (outcome.handled) {
      if (outcome.settings) await mergeSettings(provider.id, outcome.settings);
      log.info(`control message on ${provider.id}: ${outcome.action ?? "handled"}`);
      return json({ status: outcome.action ?? "handled" });
    }
  }

  const received = client.inbound?.received ? await client.inbound.received(signed) : null;
  if (received) return json(await receiveProviderMail(provider.id, received));

  if (provider.shared && client.tenants) {
    return json(await applyTenantStatus(provider, client, client.tenants.parseStatus(signed)));
  }

  const counts: ReceiptCounts = { applied: 0, ignored: 0 };
  for (const result of await applyEvents({ id: provider.id, organizationId: organizationOf(provider) }, client.events.parse(signed))) {
    if (result.outcome === "recorded") counts.applied += 1;
    else counts.ignored += 1;
  }

  return json(counts);
}
