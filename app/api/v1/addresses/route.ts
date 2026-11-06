import { ZodError } from "zod";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { addressCallerFor, createAddress, listAddresses } from "@/lib/addresses/manage";
import { createAddressSchema, listAddressesSchema } from "@/lib/schemas/address";
import { validationError } from "@/lib/schemas/validation-error";
import { projectPage, selectShape } from "@/lib/api/shape";
import { addressShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

async function post(request: Request, key: OrganizationKeyRow): Promise<Response> {
  const caller = addressCallerFor(key);
  const body = await readJson(request);
  try {
    return json(await createAddress(caller, createAddressSchema.parse(body)), 201);
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, body);
    throw error;
  }
}

async function get(request: Request, key: OrganizationKeyRow): Promise<Response> {
  const caller = addressCallerFor(key);
  const query = Object.fromEntries(new URL(request.url).searchParams);
  try {
    const { limit, cursor, domain, status, fields } = listAddressesSchema.parse(query);
    return json(projectPage(await listAddresses(caller, limit, cursor, { domain, status }), selectShape(addressShape, { fields })));
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
