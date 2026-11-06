import { ZodError } from "zod";
import { assertLiveKey, type OrganizationKeyRow } from "@/lib/api/keys";
import { json, methodPolicy } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { listInboundMessages } from "@/lib/inbound/list";
import { inboundReadShape, listInboundSchema } from "@/lib/schemas/inbound";
import { selectShape } from "@/lib/api/shape";
import { validationError } from "@/lib/schemas/validation-error";

export const dynamic = "force-dynamic";

async function get(request: Request, key: OrganizationKeyRow): Promise<Response> {
  assertLiveKey(key, "read received mail");
  const query = Object.fromEntries(new URL(request.url).searchParams);
  try {
    const { limit, cursor, domain, outbound_message, include, fields } = listInboundSchema.parse(query);
    const page = await listInboundMessages(
      { organizationId: key.organizationId, domainIds: key.domainIds },
      limit,
      cursor,
      { domain, outboundMessage: outbound_message },
      selectShape(inboundReadShape, { include, fields }),
    );
    return json(page);
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, query);
    throw error;
  }
}

export const GET = withApiKey(get);

const { rejected, options } = methodPolicy("GET");
export const POST = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
