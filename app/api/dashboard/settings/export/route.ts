import { requireAdmin } from "@/lib/auth/admin";
import { withRequestId } from "@/lib/api/request-context";
import { errorResponse } from "@/lib/api/response";
import { exportSettingsFile, settingsFile } from "@/lib/settings/file";
import { readSettings } from "@/lib/settings/values";

export const dynamic = "force-dynamic";

/** The install's resolved settings as YAML in the config file's shape, for Admin settings → General. Admins only. */
async function get(_request: Request): Promise<Response> {
  try {
    await requireAdmin();
  } catch {
    return new Response(null, { status: 404 });
  }
  try {
    const yaml = exportSettingsFile(await readSettings());
    return new Response(yaml, {
      headers: {
        "content-type": "application/yaml; charset=utf-8",
        "content-disposition": `attachment; filename="${settingsFile().name}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = withRequestId(get);
