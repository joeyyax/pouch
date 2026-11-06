import { ZodError } from "zod";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { readOrganizationRecord, updateOrganization, type OrganizationCaller } from "@/lib/organizations";
import { updateOrganizationSettingsSchema } from "@/lib/schemas/organization-settings";
import { validationError } from "@/lib/schemas/validation-error";
import { project, readSelection } from "@/lib/api/shape";
import { organizationShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

function callerFor(key: OrganizationKeyRow): OrganizationCaller {
  return { organizationId: key.organizationId, domainIds: key.domainIds, actor: apiKeyActor(key.id, key.name) };
}

async function get(request: Request, key: OrganizationKeyRow): Promise<Response> {
  const selection = readSelection(request, organizationShape);
  return json(project(await readOrganizationRecord(callerFor(key), { addressCounts: selection.expands("address_counts") }), selection));
}

async function patch(request: Request, key: OrganizationKeyRow): Promise<Response> {
  const body = await readJson(request);
  try {
    return json(await updateOrganization(callerFor(key), updateOrganizationSettingsSchema.parse(body)));
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, body);
    throw error;
  }
}

export const GET = withApiKey(get);
export const PATCH = withApiKey(patch);

const { rejected, options } = methodPolicy("GET", "PATCH");
export const POST = rejected;
export const PUT = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
