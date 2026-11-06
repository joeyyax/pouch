import type { OrganizationKeyRow } from "@/lib/api/keys";
import { json, methodPolicy } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { readForwardTarget, removeForwardTarget } from "@/lib/addresses/forward-targets";
import { project, readSelection } from "@/lib/api/shape";
import { forwardTargetShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string; targetId: string }>;
}

async function get(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const selection = readSelection(request, forwardTargetShape);
  const { id, targetId } = await context.params;
  return json(project(await readForwardTarget(key, id, targetId), selection));
}

async function del(_request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const { id, targetId } = await context.params;
  return json(await removeForwardTarget(key, id, targetId));
}

export const GET = withApiKey<Context>(get);
export const DELETE = withApiKey<Context>(del);

const { rejected, options } = methodPolicy("GET", "DELETE");
export const POST = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const OPTIONS = options;
