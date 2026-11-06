import type { ApiKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { withAdminKey } from "@/lib/api/with-key";
import { createAdminProvider } from "@/lib/providers/admin";
import { listAdminProviders, readAdminProvider } from "@/lib/providers/admin-read";
import { createAdminProviderSchema, listAdminProvidersSchema, parseAdmin } from "@/lib/schemas/admin";
import { projectPage, selectShape } from "@/lib/api/shape";
import { adminProviderShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

async function get(request: Request): Promise<Response> {
  const query = parseAdmin(listAdminProvidersSchema, Object.fromEntries(new URL(request.url).searchParams));
  const selection = selectShape(adminProviderShape, query);
  return json(projectPage(await listAdminProviders({ ...query, health: selection.expands("health") }), selection));
}

async function post(request: Request, key: ApiKeyRow): Promise<Response> {
  const body = parseAdmin(createAdminProviderSchema, await readJson(request));
  const { provider, verified, configured } = await createAdminProvider(body, { actor: apiKeyActor(key.id, key.name) });
  return json({ ...(await readAdminProvider(provider.id)), credentials_verified: verified, configured }, 201);
}

export const GET = withAdminKey(get);
export const POST = withAdminKey(post);

const { rejected, options } = methodPolicy("GET", "POST");
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
