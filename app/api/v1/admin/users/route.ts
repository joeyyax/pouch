import { json, methodPolicy } from "@/lib/api/response";
import { withAdminKey } from "@/lib/api/with-key";
import { listOperatorAccounts } from "@/lib/operators";
import { listAdminUsersSchema, parseAdmin } from "@/lib/schemas/admin";
import { projectPage, selectShape } from "@/lib/api/shape";
import { accountShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

async function get(request: Request): Promise<Response> {
  const query = parseAdmin(listAdminUsersSchema, Object.fromEntries(new URL(request.url).searchParams));
  const selection = selectShape(accountShape, query);
  return json(projectPage(await listOperatorAccounts({ ...query, memberships: selection.expands("memberships") }), selection));
}

export const GET = withAdminKey(get);

const { rejected, options } = methodPolicy("GET");
export const POST = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
