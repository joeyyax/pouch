import type { ApiKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy } from "@/lib/api/response";
import { withAdminKey } from "@/lib/api/with-key";
import { resendInvitation } from "@/lib/invitations";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string; invitationId: string }>;
}

async function post(_request: Request, key: ApiKeyRow, context: Context): Promise<Response> {
  const { id, invitationId } = await context.params;
  return json(await resendInvitation(id, invitationId, { actor: apiKeyActor(key.id, key.name) }));
}

export const POST = withAdminKey<Context>(post);

const { rejected, options } = methodPolicy("POST");
export const GET = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
