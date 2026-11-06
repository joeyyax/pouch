import { ZodError } from "zod";
import { ApiError } from "@/lib/api/errors";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { keyCanAccessDomain } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { readInboundStatus, updateInboundSettings, type InboundCaller } from "@/lib/inbound/manage";
import { updateInboundSchema } from "@/lib/schemas/inbound";
import { validationError } from "@/lib/schemas/validation-error";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

function callerFor(key: OrganizationKeyRow): InboundCaller {
  return { organizationId: key.organizationId, actor: apiKeyActor(key.id, key.name) };
}

function serializeStatus(status: Awaited<ReturnType<typeof readInboundStatus>>, webhookSecret?: string | null) {
  return {
    domain_id: status.domainId,
    enabled: status.enabled,
    retention_days: status.retentionDays,
    subdomain: status.subdomain,
    host: status.host,
    webhook_url: status.webhookUrl,
    receiver_url: status.receiverUrl,
    dns_records: status.dnsRecords,
    ...(webhookSecret ? { webhook_secret: webhookSecret } : {}),
  };
}

async function get(_request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  if (!keyCanAccessDomain(key, id)) throw new ApiError("key_not_scoped", "This key can't read this domain.");
  const status = await readInboundStatus(callerFor(key), id);
  return json(serializeStatus(status));
}

async function patch(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  if (!keyCanAccessDomain(key, id)) throw new ApiError("key_not_scoped", "This key can't change this domain.");
  const body = await readJson(request);
  try {
    const parsed = updateInboundSchema.parse(body);
    const { status, webhookSecret } = await updateInboundSettings(callerFor(key), id, parsed);
    return json(serializeStatus(status, webhookSecret));
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, body);
    throw error;
  }
}

export const GET = withApiKey<Context>(get);
export const PATCH = withApiKey<Context>(patch);

const { rejected, options } = methodPolicy("GET", "PATCH");
export const POST = rejected;
export const PUT = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
