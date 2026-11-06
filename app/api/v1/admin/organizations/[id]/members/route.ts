import type { ApiKeyRow } from "@/lib/api/keys";
import { json, methodPolicy } from "@/lib/api/response";
import { withAdminKey } from "@/lib/api/with-key";
import { listMembers } from "@/lib/memberships";
import { listMembershipsSchema, parseAdmin } from "@/lib/schemas/admin";
import { projectPage, selectShape } from "@/lib/api/shape";
import { memberShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

async function get(request: Request, _key: ApiKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  const query = parseAdmin(listMembershipsSchema, Object.fromEntries(new URL(request.url).searchParams));
  return json(projectPage(await listMembers(id, query), selectShape(memberShape, query)));
}

export const GET = withAdminKey<Context>(get);

const { rejected, options } = methodPolicy("GET");
export const POST = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
