import { ZodError } from "zod";
import { assertLiveKey, type OrganizationKeyRow } from "@/lib/api/keys";
import { json, methodPolicy } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { listAddressMessages } from "@/lib/addresses/inbox";
import { listAddressMessagesSchema } from "@/lib/schemas/address";
import { validationError } from "@/lib/schemas/validation-error";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

async function get(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  assertLiveKey(key, "read an address's mail");
  const { id } = await context.params;
  const query = Object.fromEntries(new URL(request.url).searchParams);
  try {
    const parsed = listAddressMessagesSchema.parse(query);
    const caller = { organizationId: key.organizationId, domainIds: key.domainIds, apiKeyId: key.id };
    return json(await listAddressMessages(caller, id, parsed, request.signal));
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
