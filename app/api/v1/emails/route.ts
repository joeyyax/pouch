import { ZodError } from "zod";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { messageUrl } from "@/lib/api/urls";
import { withApiKey } from "@/lib/api/with-key";
import { acceptMessage } from "@/lib/messages/create";
import { listMessages } from "@/lib/messages/list";
import { serializeMessage } from "@/lib/messages/serialize";
import { notifyQueued } from "@/lib/messages/queue";
import { sendEmailSchema, type SendEmailRequest } from "@/lib/schemas/email";
import { listMessagesSchema, messageListShape } from "@/lib/schemas/message";
import { selectShape } from "@/lib/api/shape";
import { validationError } from "@/lib/schemas/validation-error";

export const dynamic = "force-dynamic";

async function post(request: Request, key: OrganizationKeyRow): Promise<Response> {
  const body = await readJson(request);
  let parsed: SendEmailRequest;
  try {
    parsed = sendEmailSchema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, body);
    throw error;
  }
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || null;

  const { message, replayed } = await acceptMessage(key, parsed, idempotencyKey);

  // The message is committed. The nudge may not turn an accepted send into an error.
  if (!replayed) await notifyQueued(message.id).catch(() => {});

  return json(serializeMessage(message), 202, { location: messageUrl(message.id) });
}

async function get(request: Request, key: OrganizationKeyRow): Promise<Response> {
  const query = Object.fromEntries(new URL(request.url).searchParams);
  try {
    const { limit, cursor, status, domain, key: keyId, batch, held, sensitive, tag, to, reason, since, until, include, fields } =
      listMessagesSchema.parse(query);
    const selection = selectShape(messageListShape, { include, fields });
    const filters = {
      status,
      domain,
      key: keyId,
      batch,
      held: held === undefined ? undefined : held === "true",
      sensitive: sensitive === undefined ? undefined : sensitive === "true",
      tag,
      to,
      reason,
      since,
      until,
    };
    return json(await listMessages(key, limit, cursor, filters, selection));
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
