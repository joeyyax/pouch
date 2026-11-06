import { ZodError } from "zod";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import {
  deleteWebhookEndpoint,
  readWebhookEndpoint,
  updateWebhookEndpoint,
  type WebhookCaller,
} from "@/lib/webhooks/manage";
import { updateWebhookEndpointSchema } from "@/lib/schemas/webhook-endpoint";
import { validationError } from "@/lib/schemas/validation-error";
import { project, readSelection } from "@/lib/api/shape";
import { webhookEndpointShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

function callerFor(key: OrganizationKeyRow): WebhookCaller {
  return { organizationId: key.organizationId, domainIds: key.domainIds, actor: apiKeyActor(key.id, key.name), mode: key.mode };
}

async function get(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const selection = readSelection(request, webhookEndpointShape);
  const { id } = await context.params;
  return json(project(await readWebhookEndpoint(callerFor(key), id), selection));
}

async function patch(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  const body = await readJson(request);
  try {
    return json(await updateWebhookEndpoint(callerFor(key), id, updateWebhookEndpointSchema.parse(body)));
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, body);
    throw error;
  }
}

async function del(_request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  return json(await deleteWebhookEndpoint(callerFor(key), id));
}

export const GET = withApiKey<Context>(get);
export const PATCH = withApiKey<Context>(patch);
export const DELETE = withApiKey<Context>(del);

const { rejected, options } = methodPolicy("GET", "PATCH", "DELETE");
export const POST = rejected;
export const PUT = rejected;
export const OPTIONS = options;
