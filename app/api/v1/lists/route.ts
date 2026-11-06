import { ZodError } from "zod";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { createList, listLists, type ListCaller } from "@/lib/lists";
import { createListSchema, listListsSchema } from "@/lib/schemas/list";
import { validationError } from "@/lib/schemas/validation-error";
import { projectPage, selectShape } from "@/lib/api/shape";
import { listShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

function callerFor(key: OrganizationKeyRow): ListCaller {
  return { organizationId: key.organizationId, domainIds: key.domainIds, actor: apiKeyActor(key.id, key.name) };
}

async function post(request: Request, key: OrganizationKeyRow): Promise<Response> {
  const body = await readJson(request);
  try {
    const parsed = createListSchema.parse(body);
    return json(await createList(callerFor(key), parsed), 201);
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, body);
    throw error;
  }
}

async function get(request: Request, key: OrganizationKeyRow): Promise<Response> {
  const query = Object.fromEntries(new URL(request.url).searchParams);
  try {
    const { limit, cursor, domain, include, fields } = listListsSchema.parse(query);
    const selection = selectShape(listShape, { include, fields });
    const page = await listLists(callerFor(key), limit, cursor, { domain }, { memberCounts: selection.expands("member_counts") });
    return json(projectPage(page, selection));
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, query);
    throw error;
  }
}

export const POST = withApiKey(post);
export const GET = withApiKey(get);

const { rejected, options } = methodPolicy("POST", "GET");
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
