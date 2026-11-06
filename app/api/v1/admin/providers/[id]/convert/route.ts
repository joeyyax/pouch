import { after } from "next/server";
import type { ApiKeyRow } from "@/lib/api/keys";
import { apiKeyActor } from "@/lib/activity/record";
import { json, methodPolicy } from "@/lib/api/response";
import { withAdminKey } from "@/lib/api/with-key";
import { adminProviderRow } from "@/lib/providers/admin-read";
import { serializeConversionPlan } from "@/lib/providers/admin-serialize";
import { conversionStatus, startConversion } from "@/lib/providers/convert-job";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

// Also answers for the assignment row the provider becomes, so a caller can poll past the flip.
async function get(_request: Request, _key: ApiKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  const { plan, conversion } = await conversionStatus(id);
  return json({ id, plan: serializeConversionPlan(plan), conversion });
}

// Copying a suppression list is one paced call per address, so the run outlives the request.
async function post(_request: Request, key: ApiKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  await adminProviderRow(id);
  const started = await startConversion(id, apiKeyActor(key.id, key.name));
  try {
    after(() => started.done);
  } catch {
    // Outside a request scope the run continues on its own.
  }
  const { plan, conversion } = await conversionStatus(id);
  return json(
    { id, started: started.started, plan: serializeConversionPlan(plan), conversion },
    started.plan.converted ? 200 : 202,
  );
}

export const GET = withAdminKey<Context>(get);
export const POST = withAdminKey<Context>(post);

const { rejected, options } = methodPolicy("GET", "POST");
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
