import type { OrganizationKeyRow } from "@/lib/api/keys";
import { json, methodPolicy } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { readReputation } from "@/lib/reputation/api";

export const dynamic = "force-dynamic";

async function get(_request: Request, key: OrganizationKeyRow): Promise<Response> {
  return json(await readReputation(key));
}

export const GET = withApiKey(get);

const { rejected, options } = methodPolicy("GET");
export const POST = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
