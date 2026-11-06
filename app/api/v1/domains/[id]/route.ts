import { ZodError } from "zod";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { deleteDomain, moveDomain, readDomain, setBulkAllowed, setDomainLayout, type DomainCaller } from "@/lib/domains";
import { patchDomainSchema } from "@/lib/schemas/domain";
import { validationError } from "@/lib/schemas/validation-error";
import { project, readSelection } from "@/lib/api/shape";
import { domainReadShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

function callerFor(key: OrganizationKeyRow): DomainCaller {
  return { organizationId: key.organizationId, domainIds: key.domainIds, actor: apiKeyActor(key.id, key.name) };
}

async function get(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const selection = readSelection(request, domainReadShape);
  const { id } = await context.params;
  const domain = await readDomain(callerFor(key), id, {
    standing: selection.expands("standing"),
    reputation: selection.expands("reputation"),
    dmarc: selection.expands("dmarc"),
  });
  return json(project(domain, selection));
}

async function patch(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  const body = await readJson(request);
  try {
    const { provider_id, bulk_allowed, layout } = patchDomainSchema.parse(body);
    // Layout first: it's the part most likely to fail validation, before anything else is written.
    if (layout !== undefined) {
      await setDomainLayout(callerFor(key), id, layout);
    }
    if (bulk_allowed !== undefined) {
      await setBulkAllowed(callerFor(key), id, bulk_allowed);
    }
    if (provider_id !== undefined) {
      return json(await moveDomain(callerFor(key), id, provider_id));
    }
    return json(await readDomain(callerFor(key), id));
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, body);
    throw error;
  }
}

async function del(_request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  return json(await deleteDomain(callerFor(key), id));
}

export const GET = withApiKey<Context>(get);
export const PATCH = withApiKey<Context>(patch);
export const DELETE = withApiKey<Context>(del);

const { rejected, options } = methodPolicy("GET", "PATCH", "DELETE");
export const POST = rejected;
export const PUT = rejected;
export const OPTIONS = options;
