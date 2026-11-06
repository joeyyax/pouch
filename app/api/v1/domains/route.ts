import { ZodError } from "zod";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { createDomain, listDomains, type DomainCaller } from "@/lib/domains";
import { createDomainSchema, listDomainsSchema } from "@/lib/schemas/domain";
import { validationError } from "@/lib/schemas/validation-error";
import { projectPage, selectShape } from "@/lib/api/shape";
import { domainShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

function callerFor(key: OrganizationKeyRow): DomainCaller {
  return { organizationId: key.organizationId, domainIds: key.domainIds, actor: apiKeyActor(key.id, key.name) };
}

async function post(request: Request, key: OrganizationKeyRow): Promise<Response> {
  const body = await readJson(request);
  try {
    const parsed = createDomainSchema.parse(body);
    const domain = await createDomain(callerFor(key), parsed);
    return json(domain, 201);
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, body);
    throw error;
  }
}

async function get(request: Request, key: OrganizationKeyRow): Promise<Response> {
  const query = Object.fromEntries(new URL(request.url).searchParams);
  try {
    const { limit, cursor, status, include, fields } = listDomainsSchema.parse(query);
    const selection = selectShape(domainShape, { include, fields });
    const page = await listDomains(callerFor(key), limit, cursor, status, { standing: selection.expands("standing") });
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
