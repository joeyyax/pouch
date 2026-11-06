import { ZodError } from "zod";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import type { ListCaller } from "@/lib/lists";
import { removeMember, updateMember } from "@/lib/lists/members";
import { updateMemberSchema } from "@/lib/schemas/list";
import { validationError } from "@/lib/schemas/validation-error";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string; memberId: string }>;
}

function callerFor(key: OrganizationKeyRow): ListCaller {
  return { organizationId: key.organizationId, domainIds: key.domainIds, actor: apiKeyActor(key.id, key.name) };
}

/** Replaces the member's attributes. Address, status and source aren't editable. */
async function patch(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const { id, memberId } = await context.params;
  const caller = callerFor(key);
  const body = await readJson(request);
  try {
    const parsed = updateMemberSchema.parse(body);
    return json(await updateMember(caller, id, memberId, parsed, caller.actor));
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, body);
    throw error;
  }
}

/** Removes a member outright — not an unsubscribe. See lib/lists/members.ts. */
async function del(_request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const { id, memberId } = await context.params;
  const caller = callerFor(key);
  return json(await removeMember(caller, id, memberId, caller.actor));
}

export const PATCH = withApiKey<Context>(patch);
export const DELETE = withApiKey<Context>(del);

const { rejected, options } = methodPolicy("PATCH", "DELETE");
export const GET = rejected;
export const POST = rejected;
export const PUT = rejected;
export const OPTIONS = options;
