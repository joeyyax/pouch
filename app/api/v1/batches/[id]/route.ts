import type { OrganizationKeyRow } from "@/lib/api/keys";
import { json, methodPolicy } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { batchFor, statusCounts } from "@/lib/bulk/create";
import { serializeBatch } from "@/lib/bulk/serialize";
import { project, readSelection } from "@/lib/api/shape";
import { batchShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

async function get(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const selection = readSelection(request, batchShape);
  const { id } = await context.params;
  const caller = { organizationId: key.organizationId, domainIds: key.domainIds };
  const batch = await batchFor(caller, id);
  return json(project(serializeBatch(batch, selection.expands("counts") ? await statusCounts(batch.id) : {}), selection));
}

export const GET = withApiKey<Context>(get);

const { rejected, options } = methodPolicy("GET");
export const POST = rejected;
export const PATCH = rejected;
export const PUT = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
