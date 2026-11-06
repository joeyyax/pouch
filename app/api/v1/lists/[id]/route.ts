import { ZodError } from "zod";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { deleteList, readList, updateList, type ListCaller } from "@/lib/lists";
import { updateListSchema } from "@/lib/schemas/list";
import { validationError } from "@/lib/schemas/validation-error";
import { project, readSelection } from "@/lib/api/shape";
import { listShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

function callerFor(key: OrganizationKeyRow): ListCaller {
  return { organizationId: key.organizationId, domainIds: key.domainIds, actor: apiKeyActor(key.id, key.name) };
}

async function get(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const selection = readSelection(request, listShape);
  const { id } = await context.params;
  return json(project(await readList(callerFor(key), id, { memberCounts: selection.expands("member_counts") }), selection));
}

async function patch(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  const body = await readJson(request);
  try {
    const parsed = updateListSchema.parse(body);
    return json(await updateList(callerFor(key), id, parsed));
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, body);
    throw error;
  }
}

async function del(_request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  return json(await deleteList(callerFor(key), id));
}

export const GET = withApiKey<Context>(get);
export const PATCH = withApiKey<Context>(patch);
export const DELETE = withApiKey<Context>(del);

const { rejected, options } = methodPolicy("GET", "PATCH", "DELETE");
export const POST = rejected;
export const PUT = rejected;
export const OPTIONS = options;
