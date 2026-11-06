import type { ApiKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy } from "@/lib/api/response";
import { withAdminKey } from "@/lib/api/with-key";
import { unassignOrganization } from "@/lib/providers/admin";
import { adminProviderRow } from "@/lib/providers/admin-read";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string; organizationId: string }>;
}

async function del(_request: Request, key: ApiKeyRow, context: Context): Promise<Response> {
  const { id, organizationId } = await context.params;
  await unassignOrganization(await adminProviderRow(id), organizationId, { actor: apiKeyActor(key.id, key.name) });
  return json({ provider_id: id, organization_id: organizationId, unassigned: true });
}

export const DELETE = withAdminKey<Context>(del);

const { rejected, options } = methodPolicy("DELETE");
export const GET = rejected;
export const POST = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const OPTIONS = options;
