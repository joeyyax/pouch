import { ZodError } from "zod";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { createBatch, type BatchCaller } from "@/lib/bulk/create";
import { createBatchSchema } from "@/lib/schemas/batch";
import { validationError } from "@/lib/schemas/validation-error";

export const dynamic = "force-dynamic";

function callerFor(key: OrganizationKeyRow): BatchCaller {
  return { organizationId: key.organizationId, domainIds: key.domainIds, apiKeyId: key.id, mode: key.mode };
}

async function post(request: Request, key: OrganizationKeyRow): Promise<Response> {
  const body = await readJson(request);
  try {
    const parsed = createBatchSchema.parse(body);
    const batch = await createBatch(callerFor(key), parsed);
    return json(batch, 201);
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, body);
    throw error;
  }
}

export const POST = withApiKey(post);

const { rejected, options } = methodPolicy("POST");
export const GET = rejected;
export const PATCH = rejected;
export const PUT = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
