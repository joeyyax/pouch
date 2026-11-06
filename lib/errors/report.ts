import * as Sentry from "@sentry/node";
import { logger } from "@/lib/logger";
import { allowlistContext, redactText, scrubEvent, type ErrorContext } from "./scrub";

const log = logger.child("errors");

/** On globalThis: Next bundles instrumentation and route handlers apart, each with its own copy of this module. */
const state = ((globalThis as unknown as { __errorReporting?: { initialized: boolean } }).__errorReporting ??= {
  initialized: false,
});

/** Same fingerprint reported more than this many times in the window is dropped, not sent. */
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;
/** Fingerprints held before the stale ones are swept. A message id makes each throw its own. */
const SEEN_LIMIT = 500;
const seen = new Map<string, { count: number; windowStart: number }>();

/** Drops entries whose window has rolled. Without it a long-running worker grows one per throw. */
function sweepSeen(now: number): void {
  for (const [key, entry] of seen) if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) seen.delete(key);
}

function fingerprint(error: unknown): string {
  const name = error instanceof Error ? error.name : "unknown";
  const message = error instanceof Error ? error.message : String(error);
  return `${name}:${message.slice(0, 200)}`;
}

/** True the first `RATE_LIMIT_MAX` times a fingerprint is seen in a window, false after. */
function withinRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = seen.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    if (seen.size >= SEEN_LIMIT) sweepSeen(now);
    seen.set(key, { count: 1, windowStart: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= RATE_LIMIT_MAX;
}

/**
 * Wires up GlitchTip when a DSN is configured. Unset means off: local dev and tests never
 * make an outbound call, and nothing has to be stubbed for them to stay that way.
 *
 * `overrides` exists for tests, to swap in a transport that captures the envelope instead of
 * sending it, without duplicating the scrubbing config below.
 */
export function initErrorReporting(release?: string, overrides: Partial<Sentry.NodeOptions> = {}): void {
  const dsn = process.env.GLITCHTIP_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.GLITCHTIP_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
    release,
    // Manual capture only. `integrations: []` is additive to Sentry's defaults, not a
    // replacement — `defaultIntegrations: false` is what actually turns off the http,
    // contextlines (source code around a stack frame) and linked-errors (`.cause` chain)
    // integrations, all of which mine ambient data this can't afford to ship.
    defaultIntegrations: false,
    integrations: [],
    sendDefaultPii: false,
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    beforeSend: (event, hint) => scrubEvent(event, hint),
    ...overrides,
  });
  state.initialized = true;
  log.info("error reporting armed");
}

/** Test-only: lets a suite reset between cases without leaking a client across them. */
export function resetErrorReportingForTests(): void {
  state.initialized = false;
  seen.clear();
}

/**
 * Reports an error with only the allowlisted context in `lib/errors/scrub.ts`. A no-op when
 * GLITCHTIP_DSN is unset, so a caller never needs to check whether reporting is on.
 */
export function reportError(error: unknown, context?: ErrorContext): void {
  if (!state.initialized) return;

  const key = fingerprint(error);
  if (!withinRateLimit(key)) return;

  const pouch = allowlistContext(context);
  const err = error instanceof Error ? error : new Error(redactText(String(error)));

  Sentry.captureException(err, (scope) => {
    scope.setContext("pouch", pouch);
    if (pouch.route) scope.setTag("route", pouch.route);
    if (pouch.errorCode) scope.setTag("error_code", pouch.errorCode);
    return scope;
  });
}

/** Flushes queued events before the process exits. Never throws. */
export async function flushErrorReporting(timeoutMs = 2000): Promise<void> {
  if (!state.initialized) return;
  await Sentry.flush(timeoutMs).catch(() => false);
}

export function isErrorReportingArmed(): boolean {
  return state.initialized;
}
