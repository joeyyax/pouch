import type { OrganizationKeyRow } from "@/lib/api/keys";
import { json, methodPolicy } from "@/lib/api/response";
import { readSelection } from "@/lib/api/shape";
import { withApiKey } from "@/lib/api/with-key";
import { findMessage } from "@/lib/messages/read";
import { messageResponse } from "@/lib/messages/response";
import { messageReadShape } from "@/lib/schemas/message";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

async function get(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const selection = readSelection(request, messageReadShape);
  const { id } = await context.params;
  return json(await messageResponse(await findMessage(key, id), selection));
}

export const GET = withApiKey<Context>(get);

const { rejected, options } = methodPolicy("GET");
export const POST = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
