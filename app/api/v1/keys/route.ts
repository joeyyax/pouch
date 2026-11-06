import { ZodError } from "zod";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { createKey, listKeys, type KeyCaller } from "@/lib/keys";
import { createKeySchema, listKeysSchema } from "@/lib/schemas/key";
import { validationError } from "@/lib/schemas/validation-error";
import { projectPage, selectShape } from "@/lib/api/shape";
import { keyShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

function callerFor(key: OrganizationKeyRow): KeyCaller {
  return {
    organizationId: key.organizationId,
    domainIds: key.domainIds,
    actor: apiKeyActor(key.id, key.name),
    mode: key.mode,
  };
}

async function post(request: Request, key: OrganizationKeyRow): Promise<Response> {
  const body = await readJson(request);
  try {
    return json(await createKey(callerFor(key), createKeySchema.parse(body)), 201);
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, body);
    throw error;
  }
}

async function get(request: Request, key: OrganizationKeyRow): Promise<Response> {
  const query = Object.fromEntries(new URL(request.url).searchParams);
  try {
    const { limit, cursor, mode, revoked, domain, fields } = listKeysSchema.parse(query);
    return json(projectPage(await listKeys(callerFor(key), limit, cursor, { mode, revoked, domain }), selectShape(keyShape, { fields })));
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
