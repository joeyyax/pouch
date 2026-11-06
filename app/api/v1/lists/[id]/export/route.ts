import type { OrganizationKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { methodPolicy } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { memberCsv, memberCsvHeaders } from "@/lib/lists/csv-export";
import { listFor, type ListCaller } from "@/lib/lists";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

function callerFor(key: OrganizationKeyRow): ListCaller {
  return { organizationId: key.organizationId, domainIds: key.domainIds, actor: apiKeyActor(key.id, key.name) };
}

async function get(_request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  const list = await listFor(callerFor(key), id);
  return new Response(await memberCsv(list.id), { status: 200, headers: memberCsvHeaders(list.name) });
}

export const GET = withApiKey<Context>(get);

const { rejected, options } = methodPolicy("GET");
export const POST = rejected;
export const PATCH = rejected;
export const PUT = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
