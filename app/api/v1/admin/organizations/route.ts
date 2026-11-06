import type { ApiKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { ApiError } from "@/lib/api/errors";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { withAdminKey } from "@/lib/api/with-key";
import { SlugTakenError } from "@/lib/organizations";
import { provisionOrganization } from "@/lib/organizations";
import { listAdminOrganizations, readAdminOrganization } from "@/lib/providers/admin-read";
import { createAdminOrganizationSchema, listAdminOrganizationsSchema, parseAdmin } from "@/lib/schemas/admin";
import { projectPage, selectShape } from "@/lib/api/shape";
import { adminOrganizationShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

async function get(request: Request): Promise<Response> {
  const query = parseAdmin(listAdminOrganizationsSchema, Object.fromEntries(new URL(request.url).searchParams));
  const selection = selectShape(adminOrganizationShape, query);
  return json(projectPage(await listAdminOrganizations({ ...query, counts: selection.expands("counts") }), selection));
}

/**
 * The key's creator owns the new organization. An admin key records who minted it and stops
 * working when that account loses its admin flag, so it's the only person the request carries.
 */
async function post(request: Request, key: ApiKeyRow): Promise<Response> {
  const body = parseAdmin(createAdminOrganizationSchema, await readJson(request));
  if (!key.createdBy) {
    throw new ApiError("validation_failed", "This key records no creator, so there's nobody to own the organization.");
  }

  try {
    const organization = await provisionOrganization(body, key.createdBy, apiKeyActor(key.id, key.name));
    return json(await readAdminOrganization(organization.id), 201);
  } catch (error) {
    if (error instanceof SlugTakenError) throw new ApiError("validation_failed", error.message, { field: "slug" });
    throw error;
  }
}

export const GET = withAdminKey(get);
export const POST = withAdminKey(post);

const { rejected, options } = methodPolicy("GET", "POST");
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
