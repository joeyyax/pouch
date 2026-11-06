import type { OrganizationKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { readProvider } from "@/lib/providers";
import { project, readSelection } from "@/lib/api/shape";
import { providerShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

async function get(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const selection = readSelection(request, providerShape);
  const { id } = await context.params;
  const caller = { organizationId: key.organizationId, domainIds: key.domainIds, actor: apiKeyActor(key.id, key.name) };
  return json(project(await readProvider(caller, id, { status: selection.expands("status") }), selection));
}

export const GET = withApiKey<Context>(get);

// Admins own every provider; organizations only read.
const { rejected, options } = methodPolicy("GET");
export const POST = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
