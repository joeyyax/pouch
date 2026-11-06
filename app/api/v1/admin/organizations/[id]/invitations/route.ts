import type { ApiKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { withAdminKey } from "@/lib/api/with-key";
import { inviteToOrganization, listInvitations } from "@/lib/invitations";
import { parseAdmin } from "@/lib/schemas/admin";
import { createInvitationSchema, listInvitationsSchema } from "@/lib/schemas/invitation";
import { projectPage, selectShape } from "@/lib/api/shape";
import { invitationShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

async function get(request: Request, _key: ApiKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  const query = parseAdmin(listInvitationsSchema, Object.fromEntries(new URL(request.url).searchParams));
  return json(projectPage(await listInvitations(id, query), selectShape(invitationShape, query)));
}

async function post(request: Request, key: ApiKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  const body = parseAdmin(createInvitationSchema, await readJson(request));
  const actor = apiKeyActor(key.id, key.name);
  return json(await inviteToOrganization(id, body, { userId: key.createdBy, actor }), 201);
}

export const GET = withAdminKey<Context>(get);
export const POST = withAdminKey<Context>(post);

const { rejected, options } = methodPolicy("GET", "POST");
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
