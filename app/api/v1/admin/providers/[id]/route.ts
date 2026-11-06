import type { ApiKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { withAdminKey } from "@/lib/api/with-key";
import { deleteAdminProvider, updateAdminProvider } from "@/lib/providers/admin";
import { adminProviderRow, readAdminProvider } from "@/lib/providers/admin-read";
import { parseAdmin, patchAdminProviderSchema } from "@/lib/schemas/admin";
import { project, readSelection } from "@/lib/api/shape";
import { adminProviderShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

async function get(request: Request, _key: ApiKeyRow, context: Context): Promise<Response> {
  const selection = readSelection(request, adminProviderShape);
  const { id } = await context.params;
  return json(project(await readAdminProvider(id, { health: selection.expands("health") }), selection));
}

async function patch(request: Request, key: ApiKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  const body = parseAdmin(patchAdminProviderSchema, await readJson(request));
  const provider = await adminProviderRow(id);
  const { verified } = await updateAdminProvider(provider, body, { actor: apiKeyActor(key.id, key.name) });
  const read = await readAdminProvider(id);
  return json(body.credentials ? { ...read, credentials_verified: verified ?? null } : read);
}

async function del(_request: Request, key: ApiKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  return json(await deleteAdminProvider(await adminProviderRow(id), { actor: apiKeyActor(key.id, key.name) }));
}

export const GET = withAdminKey<Context>(get);
export const PATCH = withAdminKey<Context>(patch);
export const DELETE = withAdminKey<Context>(del);

const { rejected, options } = methodPolicy("GET", "PATCH", "DELETE");
export const POST = rejected;
export const PUT = rejected;
export const OPTIONS = options;
