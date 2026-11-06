import { apiKeyActor } from "@/lib/activity/record";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { ApiError } from "@/lib/api/errors";
import { json, methodPolicy } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { removeSuppression } from "@/lib/messages/suppression-manage";
import { readSuppression, requireUnscopedKey, serializeSuppression } from "@/lib/messages/suppression";
import { project, readSelection } from "@/lib/api/shape";
import { suppressionShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ address: string }>;
}

/** One suppression, by id or by address. */
async function get(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  requireUnscopedKey(key);
  const selection = readSelection(request, suppressionShape);
  const { address } = await context.params;
  const row = await readSuppression(key.organizationId, address);
  if (!row) throw new ApiError("not_found", `${address} isn't on the suppression list.`);
  return json(project(serializeSuppression(row), selection));
}

/** Takes an address off the list. Sends to it go out again. */
async function del(_request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  requireUnscopedKey(key);
  const { address } = await context.params;
  const removed = await removeSuppression(key.organizationId, address, apiKeyActor(key.id, key.name));
  return json({ address: removed, removed: true });
}

export const GET = withApiKey<Context>(get);
export const DELETE = withApiKey<Context>(del);

const { rejected, options } = methodPolicy("GET", "DELETE");
export const POST = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const OPTIONS = options;
