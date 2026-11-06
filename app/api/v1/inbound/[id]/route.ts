import { ApiError } from "@/lib/api/errors";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { assertLiveKey, keyCanAccessDomain } from "@/lib/api/keys";
import { json, methodPolicy } from "@/lib/api/response";
import { readSelection } from "@/lib/api/shape";
import { withApiKey } from "@/lib/api/with-key";
import { readInboundMessage } from "@/lib/inbound/list";
import { inboundResponse } from "@/lib/inbound/serialize";
import { inboundReadShape } from "@/lib/schemas/inbound";
import { latestInboundDeliveries } from "@/lib/webhooks/deliveries";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

async function get(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  assertLiveKey(key, "read received mail");
  const selection = readSelection(request, inboundReadShape);

  const { id } = await context.params;
  const message = await readInboundMessage(key.organizationId, id);
  if (!message) throw new ApiError("not_found", `No inbound message with id ${id}.`);
  if (!keyCanAccessDomain(key, message.domainId)) {
    throw new ApiError("key_not_scoped", "This key can't read this message.");
  }
  const delivery = selection.expands("delivery") ? ((await latestInboundDeliveries(key.organizationId, [message]))[message.id] ?? null) : undefined;
  return json(await inboundResponse(message, selection, delivery));
}

export const GET = withApiKey<Context>(get);

const { rejected, options } = methodPolicy("GET");
export const POST = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
