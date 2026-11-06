import { withRequestId } from "@/lib/api/request-context";
import { pingDb } from "@/lib/db";
import { readiness } from "@/lib/health/readyz";

export const dynamic = "force-dynamic";

/**
 * Bare: Postgres only, for the container healthcheck's fast poll. `?detail`: every registered
 * check (lib/health/readyz.ts), for a monitor — never both on the same call (docs/decisions.md,
 * "The fast poll's status code stays untouchable by a third party").
 */
async function get(request: Request): Promise<Response> {
  const detail = new URL(request.url).searchParams.has("detail");

  if (detail) {
    const report = await readiness();
    return new Response(JSON.stringify(report), {
      status: report.ok ? 200 : 503,
      headers: { "content-type": "application/json" },
    });
  }

  const database = await pingDb();
  return new Response(JSON.stringify({ ok: database, database }), {
    status: database ? 200 : 503,
    headers: { "content-type": "application/json" },
  });
}

export const GET = withRequestId(get);
