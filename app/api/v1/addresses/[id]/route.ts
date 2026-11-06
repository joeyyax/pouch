import { ZodError } from "zod";
import { assertLiveKey, type OrganizationKeyRow } from "@/lib/api/keys";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { readAddress, revokeAddress, updateAddress, type AddressCaller } from "@/lib/addresses/manage";
import { updateAddressSchema } from "@/lib/schemas/address";
import { validationError } from "@/lib/schemas/validation-error";
import { project, readSelection } from "@/lib/api/shape";
import { addressShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

function callerFor(key: OrganizationKeyRow): AddressCaller {
  assertLiveKey(key, "manage addresses");
  return { organizationId: key.organizationId, domainIds: key.domainIds, apiKeyId: key.id };
}

async function get(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const caller = callerFor(key);
  const selection = readSelection(request, addressShape);
  const { id } = await context.params;
  return json(project(await readAddress(caller, id), selection));
}

async function patch(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const caller = callerFor(key);
  const { id } = await context.params;
  const body = await readJson(request);
  try {
    return json(await updateAddress(caller, id, updateAddressSchema.parse(body)));
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, body);
    throw error;
  }
}

async function del(_request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const caller = callerFor(key);
  const { id } = await context.params;
  return json(await revokeAddress(caller, id));
}

export const GET = withApiKey<Context>(get);
export const PATCH = withApiKey<Context>(patch);
export const DELETE = withApiKey<Context>(del);

const { rejected, options } = methodPolicy("GET", "PATCH", "DELETE");
export const POST = rejected;
export const PUT = rejected;
export const OPTIONS = options;
