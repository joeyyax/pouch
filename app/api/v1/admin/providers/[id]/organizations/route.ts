import type { ApiKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { withAdminKey } from "@/lib/api/with-key";
import { assignOrganization } from "@/lib/providers/admin";
import { listProviderAssignments } from "@/lib/providers/admin-read";
import { assignOrganizationSchema, listProviderOrganizationsSchema, parseAdmin } from "@/lib/schemas/admin";
import { projectPage, selectShape } from "@/lib/api/shape";
import { assignmentShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

async function get(request: Request, _key: ApiKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  const query = parseAdmin(listProviderOrganizationsSchema, Object.fromEntries(new URL(request.url).searchParams));
  return json(projectPage(await listProviderAssignments(id, query), selectShape(assignmentShape, query)));
}

// No provider call: the tenant is created with the organization's first domain.
async function post(request: Request, key: ApiKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  const body = parseAdmin(assignOrganizationSchema, await readJson(request));
  const assignment = await assignOrganization(id, body.organization_id, { default: body.default }, { actor: apiKeyActor(key.id, key.name) });
  const { data } = await listProviderAssignments(id, { limit: 200 });
  const found = data.find((entry) => entry.provider_id === assignment.id);
  return json(found ?? { organization_id: body.organization_id, provider_id: assignment.id }, 201);
}

export const GET = withAdminKey<Context>(get);
export const POST = withAdminKey<Context>(post);

const { rejected, options } = methodPolicy("GET", "POST");
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
