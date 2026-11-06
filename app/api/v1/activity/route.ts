import { ZodError } from "zod";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { json, methodPolicy } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { listActivityRecords } from "@/lib/activity/read";
import { listActivitySchema } from "@/lib/schemas/activity";
import { validationError } from "@/lib/schemas/validation-error";
import { projectPage, selectShape } from "@/lib/api/shape";
import { activityShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

async function get(request: Request, key: OrganizationKeyRow): Promise<Response> {
  const query = Object.fromEntries(new URL(request.url).searchParams);
  try {
    const { limit, cursor, family, outcome, actor, since, fields } = listActivitySchema.parse(query);
    const page = await listActivityRecords(key, limit, cursor, { family, outcome, actor, since });
    return json(projectPage(page, selectShape(activityShape, { fields })));
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
