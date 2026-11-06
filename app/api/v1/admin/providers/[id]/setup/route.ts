import type { ApiKeyRow } from "@/lib/api/keys";
import { json, methodPolicy } from "@/lib/api/response";
import { withAdminKey } from "@/lib/api/with-key";
import { setupAdminProvider } from "@/lib/providers/admin";
import { adminProviderRow, readAdminProvider } from "@/lib/providers/admin-read";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

// Inline: setup is about ten paced provider calls, the same work adding a first domain does.
async function post(_request: Request, _key: ApiKeyRow, context: Context): Promise<Response> {
  const { id } = await context.params;
  const configured = await setupAdminProvider(await adminProviderRow(id));
  return json({ ...(await readAdminProvider(id)), configured });
}

export const POST = withAdminKey<Context>(post);

const { rejected, options } = methodPolicy("POST");
export const GET = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const OPTIONS = options;
