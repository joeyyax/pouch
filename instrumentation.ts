import type { Instrumentation } from "next";

/**
 * Runs once when the app server starts, before it serves anything. The Sentry SDK only
 * initializes here (not in the edge runtime, which never throws the errors this is for).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Skipped during next build, which runs without the deployment's env.
  if (process.env.NEXT_PHASE !== "phase-production-build") {
    const { checkBootConfig } = await import("@/lib/config");
    checkBootConfig("app");
  }
  const { initErrorReporting } = await import("@/lib/errors/report");
  initErrorReporting(process.env.GIT_SHA);

  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { runHooksOnHostExit } = await import("@/lib/lifecycle");
  runHooksOnHostExit();

  const { loadSessionLength } = await import("@/lib/auth/session-length");
  await loadSessionLength();
}

/**
 * Server errors Next.js catches itself: a render that throws, a route handler that throws
 * past its own try/catch, a Server Action that throws. `request` and `context` carry a raw
 * header map and query string — never passed through, only the allowlisted pieces below.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { reportError } = await import("@/lib/errors/report");
  const path = request.path.split("?")[0];
  reportError(error, {
    route: path,
    routeType: context.routeType,
    method: request.method,
  });
};
