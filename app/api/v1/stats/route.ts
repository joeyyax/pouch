import { ZodError } from "zod";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { json, methodPolicy } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { selectShape } from "@/lib/api/shape";
import { readStats } from "@/lib/stats";
import { readStatsSchema, statsShape } from "@/lib/schemas/stats";
import { validationError } from "@/lib/schemas/validation-error";

export const dynamic = "force-dynamic";

async function get(request: Request, key: OrganizationKeyRow): Promise<Response> {
  const query = Object.fromEntries(new URL(request.url).searchParams);
  try {
    const { include, fields, ...filters } = readStatsSchema.parse(query);
    const selection = selectShape(statsShape, { include, fields });
    return json(await readStats({ organizationId: key.organizationId, domainIds: key.domainIds, mode: key.mode }, filters, selection));
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, query);
    throw error;
  }
}

export const GET = withApiKey(get);

const { rejected, options } = methodPolicy("GET");
export const POST = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
