import type { ApiKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { withAdminKey } from "@/lib/api/with-key";
import { setAddressLimits, setOrganizationDefault } from "@/lib/providers/admin";
import { readAdminOrganization } from "@/lib/providers/admin-read";
import { parseAdmin, patchAdminOrganizationSchema } from "@/lib/schemas/admin";
import { deleteOrganization } from "@/lib/organizations/delete";
import { project, readSelection } from "@/lib/api/shape";
import { adminOrganizationShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

async function get(request: Request, _key: ApiKeyRow, context: Context): Promise<Response> {
  const selection = readSelection(request, adminOrganizationShape);
  const { id } = await context.params;
  return json(project(await readAdminOrganization(id, { counts: selection.expands("counts") }), selection));
}

async function patch(request: Request, key: ApiKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  const body = parseAdmin(patchAdminOrganizationSchema, await readJson(request));
  await readAdminOrganization(id);
  const actor = apiKeyActor(key.id, key.name);
  if (body.provider_id !== undefined) await setOrganizationDefault(id, body.provider_id, { actor });
  await setAddressLimits(id, { addressLimit: body.address_limit, addressDailyMessageLimit: body.address_daily_message_limit }, { actor });
  return json(await readAdminOrganization(id));
}

async function del(_request: Request, key: ApiKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  return json(await deleteOrganization(id, apiKeyActor(key.id, key.name)));
}

export const GET = withAdminKey<Context>(get);
export const PATCH = withAdminKey<Context>(patch);
export const DELETE = withAdminKey<Context>(del);

const { rejected, options } = methodPolicy("GET", "PATCH", "DELETE");
export const POST = rejected;
export const PUT = rejected;
export const OPTIONS = options;
