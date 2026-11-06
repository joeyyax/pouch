import type { ApiKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { withAdminKey } from "@/lib/api/with-key";
import { removeMember, updateMemberRole } from "@/lib/memberships";
import { parseAdmin, patchMembershipSchema } from "@/lib/schemas/admin";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string; userId: string }>;
}

async function patch(request: Request, key: ApiKeyRow, context: Context): Promise<Response> {
  const { id, userId } = await context.params;
  const body = parseAdmin(patchMembershipSchema, await readJson(request));
  return json(await updateMemberRole(id, userId, body.role, apiKeyActor(key.id, key.name)));
}

async function del(_request: Request, key: ApiKeyRow, context: Context): Promise<Response> {
  const { id, userId } = await context.params;
  return json(await removeMember(id, userId, apiKeyActor(key.id, key.name)));
}

export const PATCH = withAdminKey<Context>(patch);
export const DELETE = withAdminKey<Context>(del);

const { rejected, options } = methodPolicy("PATCH", "DELETE");
export const GET = rejected;
export const POST = rejected;
export const PUT = rejected;
export const OPTIONS = options;
