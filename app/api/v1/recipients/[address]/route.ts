import type { OrganizationKeyRow } from "@/lib/api/keys";
import { json, methodPolicy } from "@/lib/api/response";
import { withApiKey } from "@/lib/api/with-key";
import { project, readSelection } from "@/lib/api/shape";
import { readRecipient } from "@/lib/recipients";
import { recipientShape } from "@/lib/schemas/shapes";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ address: string }>;
}

/** One address: what was sent to it, how it went, and what stops the next send. */
async function get(request: Request, key: OrganizationKeyRow, context: Context): Promise<Response> {
  const selection = readSelection(request, recipientShape);
  const { address } = await context.params;
  const recipient = await readRecipient({ organizationId: key.organizationId, domainIds: key.domainIds, mode: key.mode }, address, selection);
  return json(project(recipient, selection));
}

export const GET = withApiKey<Context>(get);

const { rejected, options } = methodPolicy("GET");
export const POST = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
