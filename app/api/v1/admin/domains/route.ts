import type { ApiKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { withAdminKey } from "@/lib/api/with-key";
import { adoptDomainForOrganization } from "@/lib/domains";
import { parseAdmin } from "@/lib/schemas/admin";
import { adoptDomainSchema } from "@/lib/schemas/domain";

export const dynamic = "force-dynamic";

// Adoption is admin-only. POST /v1/domains still answers domain_unavailable for the same name.
async function post(request: Request, key: ApiKeyRow): Promise<Response> {
  const body = parseAdmin(adoptDomainSchema, await readJson(request));
  const domain = await adoptDomainForOrganization(body, apiKeyActor(key.id, key.name));
  return json({ ...domain, adopted: true }, 201);
}

export const POST = withAdminKey(post);

const { rejected, options } = methodPolicy("POST");
export const GET = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
