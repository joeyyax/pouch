import type { ApiKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy } from "@/lib/api/response";
import { withAdminKey } from "@/lib/api/with-key";
import { revokeInvitation } from "@/lib/invitations";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string; invitationId: string }>;
}

async function del(_request: Request, key: ApiKeyRow, context: Context): Promise<Response> {
  const { id, invitationId } = await context.params;
  return json(await revokeInvitation(id, invitationId, apiKeyActor(key.id, key.name)));
}

export const DELETE = withAdminKey<Context>(del);

const { rejected, options } = methodPolicy("DELETE");
export const GET = rejected;
export const POST = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const OPTIONS = options;
