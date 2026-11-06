import { ZodError } from "zod";
import { ApiError } from "@/lib/api/errors";
import { assertLiveKey, type OrganizationKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { exportUrl } from "@/lib/api/urls";
import { withApiKey } from "@/lib/api/with-key";
import type { MessageFilters } from "@/lib/messages/filters";
import { countOrganizationData } from "@/lib/exports/data";
import { countExportableMessages } from "@/lib/exports/messages-query";
import { queueExport } from "@/lib/exports/create";
import { listExportRecords } from "@/lib/exports/records";
import { serializeExport } from "@/lib/exports/serialize";
import { createExportSchema, listExportsSchema, type CreateExportRequest } from "@/lib/schemas/export";
import { validationError } from "@/lib/schemas/validation-error";
import { project, selectShape } from "@/lib/api/shape";
import { exportShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

function filtersFor(request: CreateExportRequest, key: OrganizationKeyRow): MessageFilters {
  return {
    statuses: request.status ? [request.status] : undefined,
    domainId: request.domain,
    tags: request.tag ? [request.tag] : undefined,
    since: request.since,
    until: request.until,
    restrictToDomainIds: key.domainIds.length > 0 ? key.domainIds : undefined,
  };
}

/**
 * Always creates a queued export and returns 202 with the id to poll, whatever the count —
 * see lib/exports/create.ts's queueExport for why this doesn't stream a file directly the
 * way the dashboard's equivalent routes do below their ceiling.
 */
async function post(request: Request, key: OrganizationKeyRow): Promise<Response> {
  assertLiveKey(key, "export: exports hold live data");
  const body = await readJson(request);
  let parsed: CreateExportRequest;
  try {
    parsed = createExportSchema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, body);
    throw error;
  }

  if (parsed.kind === "data" && key.domainIds.length > 0) {
    throw new ApiError("key_not_scoped", "This key is scoped to specific domains and can't export organization-wide data.");
  }

  const filters = filtersFor(parsed, key);
  const count =
    parsed.kind === "data"
      ? await countOrganizationData(key.organizationId)
      : await countExportableMessages(key.organizationId, filters);

  const record = await queueExport({
    organizationId: key.organizationId,
    actor: apiKeyActor(key.id, key.name),
    kind: parsed.kind,
    filters: parsed.kind === "data" ? undefined : filters,
    count,
  });

  return json(await serializeExport(record), 202, { location: exportUrl(record.id) });
}

async function get(request: Request, key: OrganizationKeyRow): Promise<Response> {
  assertLiveKey(key, "read exports: they hold live data");
  const query = Object.fromEntries(new URL(request.url).searchParams);
  try {
    const { limit, cursor, fields } = listExportsSchema.parse(query);
    const selection = selectShape(exportShape, { fields });
    const page = await listExportRecords(key.organizationId, limit, cursor, key.domainIds);
    const data = await Promise.all(page.data.map(serializeExport));
    return json({ data: data.map((item) => project(item, selection)), next_cursor: page.nextCursor });
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
