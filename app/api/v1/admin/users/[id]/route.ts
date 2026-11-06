import type { ApiKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { withAdminKey } from "@/lib/api/with-key";
import { deleteOperatorAccount, readOperatorAccount, setOperatorAdmin } from "@/lib/operators";
import { parseAdmin, patchAdminUserSchema } from "@/lib/schemas/admin";
import { project, readSelection } from "@/lib/api/shape";
import { accountShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

async function get(request: Request, _key: ApiKeyRow, context: Context): Promise<Response> {
  const selection = readSelection(request, accountShape);
  const { id } = await context.params;
  return json(project(await readOperatorAccount(id, { memberships: selection.expands("memberships") }), selection));
}

async function patch(request: Request, key: ApiKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  const body = parseAdmin(patchAdminUserSchema, await readJson(request));
  return json(await setOperatorAdmin(id, body.admin, apiKeyActor(key.id, key.name)));
}

async function del(_request: Request, key: ApiKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  return json(await deleteOperatorAccount(id, apiKeyActor(key.id, key.name)));
}

export const GET = withAdminKey<Context>(get);
export const PATCH = withAdminKey<Context>(patch);
export const DELETE = withAdminKey<Context>(del);

const { rejected, options } = methodPolicy("GET", "PATCH", "DELETE");
export const POST = rejected;
export const PUT = rejected;
export const OPTIONS = options;
