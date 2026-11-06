import type { OrganizationKeyRow } from "@/lib/api/keys";
import { json, methodPolicy } from "@/lib/api/response";
import { messageUrl } from "@/lib/api/urls";
import { withApiKey } from "@/lib/api/with-key";
import { notifyQueued } from "@/lib/messages/queue";
import { findMessage } from "@/lib/messages/read";
import { resendMessage } from "@/lib/messages/resend";
import { serializeMessage } from "@/lib/messages/serialize";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

async function post(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  const original = await findMessage(key, id);
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || null;

  const { message, replayed } = await resendMessage(
    { organizationId: key.organizationId, apiKeyId: key.id, domainIds: key.domainIds },
    original,
    idempotencyKey,
  );

  // The message is committed. The nudge may not turn an accepted send into an error.
  if (!replayed) await notifyQueued(message.id).catch(() => {});

  return json(serializeMessage(message), 202, { location: messageUrl(message.id) });
}

export const POST = withApiKey<Context>(post);

const { rejected, options } = methodPolicy("POST");
export const GET = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
