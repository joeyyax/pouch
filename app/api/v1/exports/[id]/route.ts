import { ApiError } from "@/lib/api/errors";
import { assertLiveKey, type OrganizationKeyRow } from "@/lib/api/keys";
import { json, methodPolicy } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { exportRecordFor } from "@/lib/exports/records";
import { serializeExport } from "@/lib/exports/serialize";
import { project, readSelection } from "@/lib/api/shape";
import { exportShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

async function get(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  assertLiveKey(key, "read exports: they hold live data");
  const selection = readSelection(request, exportShape);
  const { id } = await context.params;
  const record = await exportRecordFor(key.organizationId, id, key.domainIds);
  if (!record) throw new ApiError("not_found", `No export with id ${id}.`);
  return json(project(await serializeExport(record), selection));
}

export const GET = withApiKey<Context>(get);

const { rejected, options } = methodPolicy("GET");
export const POST = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
