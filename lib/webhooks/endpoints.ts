import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { webhookEndpoints, type WebhookEndpointRow, type WebhookEventType } from "@/lib/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { newId } from "@/lib/ids";
import { ApiError } from "@/lib/api/errors";
import { resolvePublicTarget, UnsafeWebhookUrlError } from "./ssrf";

/** A signing secret, shown once at creation or on an explicit reveal/rotate. */
function generateSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

async function assertSafeUrl(url: string): Promise<void> {
  try {
    await resolvePublicTarget(url);
  } catch (err) {
    if (err instanceof UnsafeWebhookUrlError) {
      throw new ApiError("validation_failed", err.message, { field: "url" });
    }
    throw err;
  }
}

export interface CreateEndpointInput {
  organizationId: string;
  apiKeyId: string;
  url: string;
  events: WebhookEventType[];
  description?: string | null;
}

export interface CreatedEndpoint {
  endpoint: WebhookEndpointRow;
  secret: string;
}

export async function createEndpoint(input: CreateEndpointInput): Promise<CreatedEndpoint> {
  await assertSafeUrl(input.url);
  const secret = generateSecret();

  const [endpoint] = await db
    .insert(webhookEndpoints)
    .values({
      id: newId("webhookEndpoint"),
      organizationId: input.organizationId,
      apiKeyId: input.apiKeyId,
      url: input.url,
      events: input.events,
      description: input.description ?? null,
      secretEncrypted: encrypt(secret),
    })
    .returning();

  if (!endpoint) throw new ApiError("provider_unavailable", "The endpoint couldn't be persisted.");
  return { endpoint, secret };
}

export async function readEndpoint(organizationId: string, id: string): Promise<WebhookEndpointRow | null> {
  const [row] = await db
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.organizationId, organizationId), eq(webhookEndpoints.id, id)))
    .limit(1);
  return row ?? null;
}

export interface UpdateEndpointInput {
  url?: string;
  events?: WebhookEventType[];
  description?: string | null;
}

export async function updateEndpoint(
  organizationId: string,
  id: string,
  input: UpdateEndpointInput,
): Promise<WebhookEndpointRow | null> {
  if (input.url) await assertSafeUrl(input.url);

  const [row] = await db
    .update(webhookEndpoints)
    .set({
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.events !== undefined ? { events: input.events } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    })
    .where(and(eq(webhookEndpoints.organizationId, organizationId), eq(webhookEndpoints.id, id)))
    .returning();
  return row ?? null;
}

/** Decrypts the current secret, for a dashboard reveal. */
export async function revealSecret(organizationId: string, id: string): Promise<string | null> {
  const row = await readEndpoint(organizationId, id);
  if (!row) return null;
  return decrypt(row.secretEncrypted);
}

/** Replaces the secret. The old one stops verifying immediately. */
export async function rotateSecret(organizationId: string, id: string): Promise<string | null> {
  const secret = generateSecret();
  const [row] = await db
    .update(webhookEndpoints)
    .set({ secretEncrypted: encrypt(secret) })
    .where(and(eq(webhookEndpoints.organizationId, organizationId), eq(webhookEndpoints.id, id)))
    .returning({ id: webhookEndpoints.id });
  return row ? secret : null;
}

export async function setDisabled(organizationId: string, id: string, disabled: boolean): Promise<WebhookEndpointRow | null> {
  const [row] = await db
    .update(webhookEndpoints)
    .set({ disabledAt: disabled ? await dbNow() : null })
    .where(and(eq(webhookEndpoints.organizationId, organizationId), eq(webhookEndpoints.id, id)))
    .returning();
  return row ?? null;
}

export async function deleteEndpoint(organizationId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(webhookEndpoints)
    .where(and(eq(webhookEndpoints.organizationId, organizationId), eq(webhookEndpoints.id, id)))
    .returning({ id: webhookEndpoints.id });
  return rows.length > 0;
}

export async function readDomainEndpoint(organizationId: string, domainId: string): Promise<WebhookEndpointRow | null> {
  const [row] = await db
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.organizationId, organizationId), eq(webhookEndpoints.domainId, domainId)))
    .limit(1);
  return row ?? null;
}

/**
 * Creates or replaces a domain's one inbound endpoint. Unlike a key-scoped endpoint, a domain
 * carries exactly one URL and always the one event, `inbound.received` — there's no allow-list
 * to pick from. Re-enabling inbound with a new URL rotates the secret along with it, the same
 * way a fresh `createEndpoint` would.
 */
export async function upsertDomainEndpoint(organizationId: string, domainId: string, url: string): Promise<CreatedEndpoint> {
  await assertSafeUrl(url);
  const secret = generateSecret();
  const secretEncrypted = encrypt(secret);

  const existing = await readDomainEndpoint(organizationId, domainId);
  const [endpoint] = existing
    ? await db
        .update(webhookEndpoints)
        .set({ url, secretEncrypted, disabledAt: null })
        .where(eq(webhookEndpoints.id, existing.id))
        .returning()
    : await db
        .insert(webhookEndpoints)
        .values({
          id: newId("webhookEndpoint"),
          organizationId,
          domainId,
          url,
          events: ["inbound.received"],
          secretEncrypted,
        })
        .returning();

  if (!endpoint) throw new ApiError("provider_unavailable", "The endpoint couldn't be persisted.");
  return { endpoint, secret };
}

export async function deleteDomainEndpoint(organizationId: string, domainId: string): Promise<boolean> {
  const rows = await db
    .delete(webhookEndpoints)
    .where(and(eq(webhookEndpoints.organizationId, organizationId), eq(webhookEndpoints.domainId, domainId)))
    .returning({ id: webhookEndpoints.id });
  return rows.length > 0;
}
