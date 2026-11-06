import { ZodError } from "zod";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { createWebhookEndpoint, listWebhookEndpoints, type WebhookCaller } from "@/lib/webhooks/manage";
import { createWebhookEndpointSchema, listWebhookEndpointsSchema } from "@/lib/schemas/webhook-endpoint";
import { validationError } from "@/lib/schemas/validation-error";
import { projectPage, selectShape } from "@/lib/api/shape";
import { webhookEndpointShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

function callerFor(key: OrganizationKeyRow): WebhookCaller {
  return { organizationId: key.organizationId, domainIds: key.domainIds, actor: apiKeyActor(key.id, key.name), mode: key.mode };
}

async function post(request: Request, key: OrganizationKeyRow): Promise<Response> {
  const body = await readJson(request);
  try {
    return json(await createWebhookEndpoint(callerFor(key), createWebhookEndpointSchema.parse(body)), 201);
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, body);
    throw error;
  }
}

async function get(request: Request, key: OrganizationKeyRow): Promise<Response> {
  const query = Object.fromEntries(new URL(request.url).searchParams);
  try {
    const { limit, cursor, key_id, fields } = listWebhookEndpointsSchema.parse(query);
    const page = await listWebhookEndpoints(callerFor(key), limit, cursor, { key_id });
    return json(projectPage(page, selectShape(webhookEndpointShape, { fields })));
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, query);
    throw error;
  }
}

export const POST = withApiKey(post);
export const GET = withApiKey(get);

const { rejected, options } = methodPolicy("POST", "GET");
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
