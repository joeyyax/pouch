import type { OrganizationKeyRow } from "@/lib/api/keys";
import { json, methodPolicy } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { resendForwardConfirmation } from "@/lib/addresses/forward-targets";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string; targetId: string }>;
}

async function post(_request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const { id, targetId } = await context.params;
  return json(await resendForwardConfirmation(key, id, targetId));
}

export const POST = withApiKey<Context>(post);

const { rejected, options } = methodPolicy("POST");
export const GET = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
