/**
 * Bulk mode's domain-wide unsubscribe (#7). New file, new route segment — doesn't touch any
 * file lib/domains/* or app/api/v1/domains/[id]/route.ts already owns.
 */
import { ZodError } from "zod";
import { ApiError } from "@/lib/api/errors";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy, readJson } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import type { ListCaller } from "@/lib/lists";
import { unsubscribeFromDomain } from "@/lib/lists/unsubscribe";
import { unsubscribeAddressSchema } from "@/lib/schemas/list";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

function callerFor(key: OrganizationKeyRow): ListCaller {
  return { organizationId: key.organizationId, domainIds: key.domainIds, actor: apiKeyActor(key.id, key.name) };
}

async function post(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  const body = await readJson(request);
  try {
    const { address } = unsubscribeAddressSchema.parse(body);
    return json(await unsubscribeFromDomain(callerFor(key), id, address));
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      throw new ApiError("validation_failed", issue ? `Field "address" isn't valid: ${issue.message}.` : "Request body isn't valid.", {
        field: "address",
      });
    }
    throw error;
  }
}

export const POST = withApiKey<Context>(post);

const { rejected, options } = methodPolicy("POST");
export const GET = rejected;
export const PATCH = rejected;
export const PUT = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
