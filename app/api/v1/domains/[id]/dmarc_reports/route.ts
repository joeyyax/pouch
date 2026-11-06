import { ZodError } from "zod";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy } from "@/lib/api/response";
import { projectPage, selectShape } from "@/lib/api/shape";
import { withApiKey } from "@/lib/api/with-key";
import { listDmarcReports } from "@/lib/dmarc/list";
import type { DomainCaller } from "@/lib/domains";
import { listDmarcReportsSchema } from "@/lib/schemas/dmarc";
import { dmarcReportShape } from "@/lib/schemas/shapes";
import { validationError } from "@/lib/schemas/validation-error";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

function callerFor(key: OrganizationKeyRow): DomainCaller {
  return { organizationId: key.organizationId, domainIds: key.domainIds, actor: apiKeyActor(key.id, key.name) };
}

async function get(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const query = Object.fromEntries(new URL(request.url).searchParams);
  const { id } = await context.params;
  try {
    const { limit, cursor, include, fields } = listDmarcReportsSchema.parse(query);
    const selection = selectShape(dmarcReportShape, { include, fields });
    const page = await listDmarcReports(callerFor(key), id, limit, cursor, { records: selection.expands("records") });
    return json(projectPage(page, selection));
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, query);
    throw error;
  }
}

export const GET = withApiKey<Context>(get);

const { rejected, options } = methodPolicy("GET");
export const POST = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
