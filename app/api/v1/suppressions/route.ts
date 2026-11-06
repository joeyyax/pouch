import { ZodError } from "zod";
import { ApiError } from "@/lib/api/errors";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy, readCapped, readJson } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { importSuppressions, listSuppressionPage, requireUnscopedKey, serializeSuppression } from "@/lib/messages/suppression";
import { parseSuppressionCsv } from "@/lib/messages/suppression-csv";
import {
  importSuppressionsCsvQuerySchema,
  importSuppressionsSchema,
  listSuppressionsSchema,
  SUPPRESSION_IMPORT_LIMIT,
} from "@/lib/schemas/suppression";
import { validationError } from "@/lib/schemas/validation-error";
import { project, selectShape } from "@/lib/api/shape";
import { suppressionShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

const DEFAULT_SOURCE = "api";

function parse<T>(input: unknown, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, input);
    throw error;
  }
}

async function post(request: Request, key: OrganizationKeyRow): Promise<Response> {
  requireUnscopedKey(key);
  const actor = apiKeyActor(key.id, key.name);

  if ((request.headers.get("content-type") ?? "").includes("text/csv")) {
    const csvQuery = Object.fromEntries(new URL(request.url).searchParams);
    const query = parse(csvQuery, () => importSuppressionsCsvQuerySchema.parse(csvQuery));
    const parsed = parseSuppressionCsv(await readCapped(request));
    if (parsed.rows.length + parsed.errors.length > SUPPRESSION_IMPORT_LIMIT) {
      throw new ApiError("validation_failed", `The file has more than ${SUPPRESSION_IMPORT_LIMIT} rows. Split it and send each part.`, {
        detail: { limit: SUPPRESSION_IMPORT_LIMIT },
      });
    }
    const result = await importSuppressions({
      organizationId: key.organizationId,
      rows: parsed.rows,
      errors: parsed.errors,
      reason: query.reason,
      source: query.source ?? DEFAULT_SOURCE,
      actor,
    });
    return json(result, 200);
  }

  const raw = await readJson(request);
  const body = parse(raw, () => importSuppressionsSchema.parse(raw));
  const result = await importSuppressions({
    organizationId: key.organizationId,
    rows: body.suppressions,
    reason: body.reason,
    source: body.source ?? DEFAULT_SOURCE,
    actor,
  });
  return json(result, 200);
}

async function get(request: Request, key: OrganizationKeyRow): Promise<Response> {
  requireUnscopedKey(key);
  const raw = Object.fromEntries(new URL(request.url).searchParams);
  const query = parse(raw, () => listSuppressionsSchema.parse(raw));
  const page = await listSuppressionPage(key.organizationId, query);
  const selection = selectShape(suppressionShape, { fields: query.fields });
  return json({ data: page.data.map((row) => project(serializeSuppression(row), selection)), next_cursor: page.nextCursor });
}

export const POST = withApiKey(post);
export const GET = withApiKey(get);

const { rejected, options } = methodPolicy("POST", "GET");
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
