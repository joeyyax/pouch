import { cookies } from "next/headers";
import { getSession } from "@/lib/auth/session";
import { ACTIVE_ORGANIZATION_COOKIE, resolveDashboardSession, sessionActor } from "@/lib/dashboard/session";
import { canWriteInOrganization } from "@/lib/auth/permissions";
import { readEmulationTicket } from "@/lib/dashboard/emulation";

import type { ActivityActor } from "@/lib/activity/types";

export interface ExportSession {
  organizationId: string;
  userId: string;
  name: string;
  actor: ActivityActor;
}

/**
 * Session-authenticated, not key-authenticated — same posture as the live-updates route
 * (app/api/dashboard/messages/route.ts). An export is a decrypted copy of everything the
 * per-message encryption protects, so it stays behind the dashboard session rather than
 * inheriting the API's key scoping rules.
 *
 * Exporting is a write — past lib/exports/limits.ts's ceiling it queues a worker job and leaves
 * an artifact in storage — so it goes through the same role check every other write does.
 */
export async function requireExportSession(): Promise<ExportSession | Response> {
  const session = await getSession();
  if (!session?.user?.id) return jsonError(401, "invalid_key", "Sign in first.");

  // The same resolution as every dashboard screen: the chosen organization, if still reachable.
  const chosen = (await cookies()).get(ACTIVE_ORGANIZATION_COOKIE)?.value ?? null;
  const resolved = await resolveDashboardSession(
    session.user.id,
    session.user as { name?: string; email: string; admin?: boolean },
    chosen,
    await readEmulationTicket(),
  );
  if (!resolved) return jsonError(401, "invalid_key", "Sign in first.");
  if (!canWriteInOrganization(resolved.role)) {
    return jsonError(403, "insufficient_role", "Your role doesn't let you export.");
  }

  return {
    organizationId: resolved.organizationId,
    userId: resolved.userId,
    name: resolved.name,
    actor: sessionActor(resolved),
  };
}

export function jsonError(status: number, code: string, message: string, detail?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error: { code, message, ...(detail ? { detail } : {}) } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
