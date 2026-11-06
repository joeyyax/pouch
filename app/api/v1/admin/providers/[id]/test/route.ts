import type { ApiKeyRow } from "@/lib/api/keys";
import { json, methodPolicy } from "@/lib/api/response";
import { withAdminKey } from "@/lib/api/with-key";
import { probeProvider } from "@/lib/providers/admin";
import { adminProviderRow } from "@/lib/providers/admin-read";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

async function post(_request: Request, _key: ApiKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  const health = await probeProvider(await adminProviderRow(id));
  return json({ id, ok: health.ok, detail: health.detail, throttled: health.throttled ?? false, checked_at: new Date().toISOString() });
}

export const POST = withAdminKey<Context>(post);

const { rejected, options } = methodPolicy("POST");
export const GET = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
