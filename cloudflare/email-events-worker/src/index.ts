/**
 * Consumes Cloudflare Email Sending's Queue event subscription and forwards each event, signed,
 * to Pouch's Cloudflare webhook endpoint. Deployed with its own `wrangler.jsonc` in this
 * directory, separately from the Next.js app — Pouch's provider adapter (lib/providers/adapters/cloudflare.ts)
 * only ever sees what this Worker posts, never the queue directly.
 *
 * Setup, once per Cloudflare account:
 *  1. `wrangler secret put SIGNING_PRIVATE_KEY_PKCS8_B64` — base64 DER PKCS8 of an Ed25519
 *     private key. Generate one with `openssl genpkey -algorithm ed25519 -outform der | base64`.
 *  2. Paste the matching public key (raw 32 bytes, base64) into this provider's
 *     `webhookPublicKey` setting in Pouch.
 *  3. Set `POUCH_WEBHOOK_URL` in wrangler.jsonc to this account's actual webhook URL.
 *  4. Create the queue and its event subscription (Compute > Queues, then the sending domain's
 *     Settings > Event subscriptions), scoped to each domain sent through this account.
 */

interface Env {
  POUCH_WEBHOOK_URL: string;
  SIGNING_PRIVATE_KEY_PKCS8_B64: string;
}

/** The shape Cloudflare's Queues event subscription delivers for Email Sending events. */
interface CloudflareEmailEvent {
  type?: string;
  source?: { type?: string; zoneId?: string; domain?: string };
  payload?: {
    messageId?: string;
    recipient?: string;
    terminal?: boolean;
    delivery?: { status?: string; smtpStatusCode?: string };
  };
}

/** What lib/providers/adapters/cloudflare.ts's `events.parse` reads. */
interface ForwardedEvent extends CloudflareEmailEvent {
  /** This queue message's own id, so a redelivered message reaches Pouch with the same event id. */
  eventId: string;
}

let cachedKey: CryptoKey | null = null;

async function signingKey(env: Env): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const der = Uint8Array.from(atob(env.SIGNING_PRIVATE_KEY_PKCS8_B64), (char) => char.charCodeAt(0));
  cachedKey = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
  return cachedKey;
}

function toBase64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

async function forward(event: CloudflareEmailEvent, id: string, env: Env): Promise<Response> {
  const forwarded: ForwardedEvent = { ...event, eventId: id };
  const body = JSON.stringify(forwarded);
  const key = await signingKey(env);
  const signature = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(body));

  return fetch(env.POUCH_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cloudflare-Worker-Signature": toBase64(signature),
    },
    body,
  });
}

export default {
  async queue(batch: MessageBatch<CloudflareEmailEvent>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const response = await forward(message.body, message.id, env);
        if (response.ok) {
          message.ack();
        } else {
          message.retry();
        }
      } catch {
        message.retry();
      }
    }
  },
};
