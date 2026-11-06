import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import { CredentialsUnreadableError } from "@/lib/providers/unreadable";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("dashboard:action");

export type ActionState =
  | { status: "idle" }
  | { status: "ok"; message: string; href?: string }
  | { status: "error"; message: string; field?: string; retryAfterMs?: number };

export const idle: ActionState = { status: "idle" };

export function succeeded(message: string, href?: string): ActionState {
  if (href === undefined) return { status: "ok", message };
  return { status: "ok", message, href };
}

/** A cooldown, not a mistake — the UI shows a countdown, not an error toast. */
export function rateLimited(message: string, retryAfterMs: number): ActionState {
  return { status: "error", message, retryAfterMs };
}

/**
 * Turns a thrown error into something an operator can act on. An ApiError already carries a
 * sentence written for a reader; anything else is logged and reported as the fallback, because
 * a driver error's text carries recipient data.
 */
export function failed(error: unknown, fallback: string): ActionState {
  if (error instanceof ApiError) {
    return { status: "error", message: error.message, ...(error.field ? { field: error.field } : {}) };
  }
  if (error instanceof CredentialsUnreadableError) {
    log.error(safeErrorMessage(error));
    return {
      status: "error",
      message: `${fallback} ${error.message} An admin re-enters them in Admin settings, Providers.`,
    };
  }
  log.error(`action failed: ${safeErrorMessage(error)}`);
  return { status: "error", message: fallback };
}