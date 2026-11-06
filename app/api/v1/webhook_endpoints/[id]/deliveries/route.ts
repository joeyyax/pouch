import { ZodError } from "zod";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import type { WebhookCaller } from "@/lib/webhooks/manage";
import { listWebhookDeliveries } from "@/lib/webhooks/deliveries";
import { listWebhookDeliveriesSchema } from "@/lib/schemas/webhook-endpoint";
import { validationError } from "@/lib/schemas/validation-error";
import { projectPage, selectShape } from "@/lib/api/shape";
import { webhookDeliveryShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

function callerFor(key: OrganizationKeyRow): WebhookCaller {
  return { organizationId: key.organizationId, domainIds: key.domainIds, actor: apiKeyActor(key.id, key.name), mode: key.mode };
}

async function get(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const query = Object.fromEntries(new URL(request.url).searchParams);
  const { id } = await context.params;
  try {
    const { limit, cursor, include, fields } = listWebhookDeliveriesSchema.parse(query);
    const selection = selectShape(webhookDeliveryShape, { include, fields });
    const page = await listWebhookDeliveries(callerFor(key), id, limit, cursor, {
      payload: selection.expands("payload"),
      attempts: selection.expands("attempts"),
    });
    return json(projectPage(page, selection));
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, query);
    throw error;
  }
}

export const GET = withApiKey<Context>(get);

const { rejected, options } = methodPolicy("GET");
export const POST = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
