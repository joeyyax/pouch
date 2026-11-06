import type { OrganizationKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import type { WebhookCaller } from "@/lib/webhooks/manage";
import { readWebhookDelivery } from "@/lib/webhooks/deliveries";
import { project, readSelection } from "@/lib/api/shape";
import { webhookDeliveryReadShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string; deliveryId: string }>;
}

function callerFor(key: OrganizationKeyRow): WebhookCaller {
  return { organizationId: key.organizationId, domainIds: key.domainIds, actor: apiKeyActor(key.id, key.name), mode: key.mode };
}

async function get(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const selection = readSelection(request, webhookDeliveryReadShape);
  const { id, deliveryId } = await context.params;
  const delivery = await readWebhookDelivery(callerFor(key), id, deliveryId, {
    payload: selection.expands("payload"),
    attempts: selection.expands("attempts"),
  });
  return json(project(delivery, selection));
}

export const GET = withApiKey<Context>(get);

const { rejected, options } = methodPolicy("GET");
export const POST = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
