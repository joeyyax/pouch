import { ZodError } from "zod";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { listProviders } from "@/lib/providers";
import { listProvidersSchema } from "@/lib/schemas/provider";
import { validationError } from "@/lib/schemas/validation-error";
import { projectPage, selectShape } from "@/lib/api/shape";
import { providerShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

async function get(request: Request, key: OrganizationKeyRow): Promise<Response> {
  const query = Object.fromEntries(new URL(request.url).searchParams);
  try {
    const { limit, cursor, include, fields } = listProvidersSchema.parse(query);
    const selection = selectShape(providerShape, { include, fields });
    const caller = { organizationId: key.organizationId, domainIds: key.domainIds, actor: apiKeyActor(key.id, key.name) };
    return json(projectPage(await listProviders(caller, limit, cursor, { status: selection.expands("status") }), selection));
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, query);
    throw error;
  }
}

export const GET = withApiKey(get);

// Admins own every provider; organizations only read.
const { rejected, options } = methodPolicy("GET");
export const POST = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
