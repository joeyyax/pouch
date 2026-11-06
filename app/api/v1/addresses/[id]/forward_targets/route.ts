import { ZodError } from "zod";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { addForwardTarget, listForwardTargets } from "@/lib/addresses/forward-targets";
import { addForwardTargetSchema } from "@/lib/schemas/address";
import { validationError } from "@/lib/schemas/validation-error";
import { projectPage, readSelection } from "@/lib/api/shape";
import { forwardTargetShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

async function post(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  const body = await readJson(request);
  try {
    return json(await addForwardTarget(key, id, addForwardTargetSchema.parse(body)), 201);
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, body);
    throw error;
  }
}

async function get(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const selection = readSelection(request, forwardTargetShape);
  const { id } = await context.params;
  return json(projectPage(await listForwardTargets(key, id), selection));
}

export const POST = withApiKey<Context>(post);
export const GET = withApiKey<Context>(get);

const { rejected, options } = methodPolicy("POST", "GET");
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
