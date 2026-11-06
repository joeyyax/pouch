"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { ApiError } from "@/lib/api/errors";
import { recordActivity } from "@/lib/activity/record";
import { sendSnippets, type SnippetLanguage } from "@/lib/dashboard/curl";
import { listDomainOptions } from "@/lib/dashboard/domain-options";
import { createKey, revokeKey, updateKey, type KeyCaller } from "@/lib/keys";
import { createKeySchema, updateKeySchema } from "@/lib/schemas/key";
import { requireOrganization, requireOrganizationWrite, sessionActor } from "@/lib/dashboard/session";
import { failed, succeeded, type ActionState } from "@/lib/dashboard/action-state";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  endpointRow,
  rotateWebhookSecret,
  updateWebhookEndpoint,
  type WebhookCaller,
} from "@/lib/webhooks/manage";
import { readDeliveryDetail } from "@/lib/dashboard/webhooks";
import { revealSecret } from "@/lib/webhooks/endpoints";
import { sendTestEvent } from "@/lib/webhooks/test-event";
import {
  createWebhookEndpointSchema,
  updateWebhookEndpointSchema,
} from "@/lib/schemas/webhook-endpoint";
import type { WebhookDeliveryDetailView } from "@/lib/dashboard/views/webhooks";

/** A dashboard session reaches every domain in its organization and mints in either mode. */
async function caller(action: string): Promise<KeyCaller & WebhookCaller> {
  const session = await requireOrganizationWrite(action);
  return {
    organizationId: session.organizationId,
    domainIds: [],
    actor: sessionActor(session),
    createdBy: session.userId,
  };
}

/** Schema paths to the form's own field names. */
const FORM_FIELD: Record<string, string> = { rate_limit: "rateLimit", domain_ids: "domainIds" };

/** A schema message as a sentence, for the field it renders under. */
function sentence(message: string): string {
  const text = message.charAt(0).toUpperCase() + message.slice(1);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function zodError(error: unknown, fallback: string): ActionState {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    return {
      status: "error",
      message: issue ? sentence(issue.message) : fallback,
      ...(issue?.path[0] ? { field: FORM_FIELD[String(issue.path[0])] ?? String(issue.path[0]) } : {}),
    };
  }
  return failed(error, fallback);
}

/** "Only these" with nothing checked would otherwise widen the key to every domain. */
function emptyScope(form: FormData): ActionState | null {
  if (form.get("domainScope") !== "specific" || form.getAll("domainIds").some(Boolean)) return null;
  return { status: "error", message: "Check at least one domain, or choose every domain.", field: "domainIds" };
}

/** What the created panel shows, once. The secret is never stored and never re-read. */
export interface CreatedKey {
  id: string;
  name: string;
  mode: "live" | "test";
  rateLimit: number;
  domainNames: string[];
  secret: string;
  /** The domain a first send goes from: a verified one it can use, else the first it's scoped to. Null when there's none. */
  sendFrom: { id: string; name: string; verified: boolean } | null;
  /** A first send with this key from `sendFrom`. Null unless that domain is verified. */
  send: SnippetLanguage[] | null;
}

export type CreateKeyState = ActionState | { status: "created"; key: CreatedKey };

export async function createKeyAction(_previous: CreateKeyState, form: FormData): Promise<CreateKeyState> {
  const session = await caller("create an API key");
  const { organizationId } = session;
  const scopeError = emptyScope(form);
  if (scopeError) return scopeError;

  try {
    const request = createKeySchema.parse({
      name: form.get("name"),
      mode: form.get("mode"),
      domain_ids: form.getAll("domainIds").map(String).filter(Boolean),
      rate_limit: form.get("rateLimit"),
    });
    const minted = await createKey(session, request);

    const options = await listDomainOptions(organizationId);
    const names = new Map(options.map((option) => [option.id, option.name]));
    const domainNames = minted.domain_ids.map((id) => names.get(id) ?? id);
    // A key scoped to nothing can send from any domain, so any verified one demonstrates it.
    const usable = minted.domain_ids.length > 0 ? options.filter((option) => minted.domain_ids.includes(option.id)) : options;
    const from = usable.find((option) => option.verified) ?? usable[0] ?? null;
    const sendFrom = from ? { id: from.id, name: from.name, verified: from.verified } : null;

    revalidatePath("/keys");
    return {
      status: "created",
      key: {
        id: minted.id,
        name: minted.name,
        mode: minted.mode,
        rateLimit: minted.rate_limit,
        domainNames,
        secret: minted.secret,
        sendFrom,
        send: sendFrom?.verified ? sendSnippets(minted.secret, sendFrom.name) : null,
      },
    };
  } catch (error) {
    return zodError(error, "The key couldn't be created.");
  }
}

export async function updateKeyAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await caller("edit an API key");
  const id = String(form.get("id") ?? "");
  const scopeError = emptyScope(form);
  if (scopeError) return scopeError;

  try {
    const request = updateKeySchema.parse({
      name: form.get("name"),
      domain_ids: form.getAll("domainIds").map(String).filter(Boolean),
      rate_limit: form.get("rateLimit"),
    });
    const key = await updateKey(session, id, request);

    revalidatePath("/keys");
    revalidatePath(`/keys/${id}`);
    return succeeded(`Key ${key.name} updated.`);
  } catch (error) {
    return zodError(error, "The key couldn't be updated.");
  }
}

export async function revokeKeyAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await caller("revoke this key");
  const id = String(form.get("id") ?? "");

  try {
    const key = await revokeKey(session, id);
    revalidatePath("/keys");
    revalidatePath(`/keys/${id}`);
    return succeeded(`Key ${key.name} revoked.`);
  } catch (error) {
    return failed(error, "The key couldn't be revoked.");
  }
}

/** The secret only exists between creation and the panel that shows it once. */
export type CreateEndpointState = ActionState | { status: "created"; secret: string };

export async function createWebhookEndpointAction(
  _previous: CreateEndpointState,
  form: FormData,
): Promise<CreateEndpointState> {
  const session = await caller("create a webhook endpoint");
  const keyId = String(form.get("keyId") ?? "");

  try {
    const request = createWebhookEndpointSchema.parse({
      key_id: keyId,
      url: form.get("url"),
      events: form.getAll("events").map(String),
      description: form.get("description") || undefined,
    });
    const created = await createWebhookEndpoint(session, request);

    revalidatePath(`/keys/${keyId}`);
    return { status: "created", secret: created.secret };
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      return {
        status: "error",
        message: issue ? sentence(issue.message) : "That endpoint isn't valid.",
        ...(issue?.path[0] ? { field: String(issue.path[0]) } : {}),
      };
    }
    return failed(error, "The endpoint couldn't be created.");
  }
}

/** A blank description clears it, so the field is as editable as the URL and the events are. */
export async function updateWebhookEndpointAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await caller("change a webhook endpoint");
  const keyId = String(form.get("keyId") ?? "");
  const id = String(form.get("endpointId") ?? "");

  try {
    const request = updateWebhookEndpointSchema.parse({
      url: String(form.get("url") ?? ""),
      events: form.getAll("events").map(String),
      description: String(form.get("description") ?? "").trim() || null,
    });
    await updateWebhookEndpoint(session, id, request);
    revalidatePath(`/keys/${keyId}`);
    return succeeded("Endpoint updated.");
  } catch (error) {
    if (error instanceof ZodError) return zodError(error, "That endpoint isn't valid.");
    return failed(error, "The endpoint couldn't be updated.");
  }
}

export type RevealSecretState = ActionState | { status: "revealed"; secret: string };

export async function revealWebhookSecretAction(_previous: RevealSecretState, form: FormData): Promise<RevealSecretState> {
  const session = await caller("reveal a webhook secret");
  const { organizationId } = session;
  const id = String(form.get("endpointId") ?? "");

  try {
    const endpoint = await endpointRow(session, id);
    const secret = await revealSecret(organizationId, id);
    if (!secret) throw new ApiError("not_found", "That endpoint isn't in this organization.");
    await recordActivity({
      organizationId,
      action: "webhook.secret.revealed",
      actor: session.actor,
      appliesTo: id,
      subjectLabel: endpoint.url,
      metadata: { apiKeyId: endpoint.apiKeyId },
    });
    return { status: "revealed", secret };
  } catch (error) {
    return failed(error, "The secret couldn't be revealed.");
  }
}

export async function rotateWebhookSecretAction(_previous: RevealSecretState, form: FormData): Promise<RevealSecretState> {
  const session = await caller("rotate a webhook secret");
  const keyId = String(form.get("keyId") ?? "");
  const id = String(form.get("endpointId") ?? "");

  try {
    const { secret } = await rotateWebhookSecret(session, id);
    revalidatePath(`/keys/${keyId}`);
    return { status: "revealed", secret };
  } catch (error) {
    return failed(error, "The secret couldn't be rotated.");
  }
}

export async function toggleWebhookDisabledAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await caller("change whether a webhook endpoint is disabled");
  const keyId = String(form.get("keyId") ?? "");
  const id = String(form.get("endpointId") ?? "");
  const disable = form.get("disable") === "true";

  try {
    await updateWebhookEndpoint(session, id, { disabled: disable });
    revalidatePath(`/keys/${keyId}`);
    return succeeded(disable ? "Endpoint disabled." : "Endpoint re-enabled.");
  } catch (error) {
    return failed(error, "The endpoint couldn't be updated.");
  }
}

export async function deleteWebhookEndpointAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await caller("delete a webhook endpoint");
  const keyId = String(form.get("keyId") ?? "");
  const id = String(form.get("endpointId") ?? "");

  try {
    await deleteWebhookEndpoint(session, id);
    revalidatePath(`/keys/${keyId}`);
    return succeeded("Endpoint deleted.");
  } catch (error) {
    return failed(error, "The endpoint couldn't be deleted.");
  }
}

/** Loads one delivery's payload and attempts for the detail dialog, called directly from a click handler. */
export async function loadDeliveryAttemptsAction(endpointId: string, deliveryId: string): Promise<WebhookDeliveryDetailView | null> {
  const session = await requireOrganization();
  return readDeliveryDetail(
    { organizationId: session.organizationId, domainIds: [], actor: sessionActor(session) },
    endpointId,
    deliveryId,
  );
}

export async function sendTestWebhookEventAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await caller("send a test event");
  const keyId = String(form.get("keyId") ?? "");
  const id = String(form.get("endpointId") ?? "");

  try {
    await sendTestEvent(await endpointRow(session, id));
    revalidatePath(`/keys/${keyId}`);
    return succeeded("Test event queued.");
  } catch (error) {
    return failed(error, "The test event couldn't be sent.");
  }
}
