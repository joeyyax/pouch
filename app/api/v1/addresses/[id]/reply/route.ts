import { ZodError } from "zod";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { messageUrl } from "@/lib/api/urls";
import { withApiKey } from "@/lib/api/with-key";
import { replyFromAddress } from "@/lib/addresses/reply";
import { notifyQueued } from "@/lib/messages/queue";
import { serializeMessage } from "@/lib/messages/serialize";
import { replyFromAddressSchema, type ReplyFromAddressRequest } from "@/lib/schemas/address";
import { validationError } from "@/lib/schemas/validation-error";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

async function post(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  const body = await readJson(request);
  let parsed: ReplyFromAddressRequest;
  try {
    parsed = replyFromAddressSchema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, body);
    throw error;
  }
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || null;

  const { message, replayed } = await replyFromAddress(key, id, parsed, idempotencyKey);
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
