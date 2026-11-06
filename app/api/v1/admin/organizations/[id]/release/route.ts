import type { ApiKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy } from "@/lib/api/response";
import { withAdminKey } from "@/lib/api/with-key";
import { releaseOrganization } from "@/lib/providers/admin";
import { readAdminOrganization } from "@/lib/providers/admin-read";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

async function post(_request: Request, key: ApiKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  const released = await releaseOrganization(id, { actor: apiKeyActor(key.id, key.name) });
  return json({ ...(await readAdminOrganization(id)), changed: released });
}

export const POST = withAdminKey<Context>(post);

const { rejected, options } = methodPolicy("POST");
export const GET = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
