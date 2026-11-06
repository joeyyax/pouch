import type { ZodError } from "zod";
import { ApiError } from "@/lib/api/errors";

function valueAt(body: unknown, path: PropertyKey[]): unknown {
  return path.reduce<unknown>(
    (current, segment) =>
      typeof current === "object" && current !== null
        ? (current as Record<PropertyKey, unknown>)[segment]
        : undefined,
    body,
  );
}

/**
 * Turns a zod failure into the `validation_failed` ApiError every `/v1` route and the SMTP
 * ingress return. `body` is the pre-parse input, used to tell "missing" from "wrong shape".
 */
export function validationError(error: ZodError, body: unknown): ApiError {
  const issue = error.issues[0];
  if (!issue) {
    return new ApiError("validation_failed", "Request body isn't valid.");
  }

  // A refine already wrote a complete message; the missing/invalid split below doesn't apply.
  if (issue.code === "custom") {
    const field = issue.path.length > 0 ? issue.path.join(".") : undefined;
    const detail = issue.params && Object.keys(issue.params).length > 0 ? { detail: issue.params } : {};
    return new ApiError("validation_failed", issue.message, { ...(field ? { field } : {}), ...detail });
  }

  if (issue.path.length === 0) {
    return new ApiError("validation_failed", "Request body isn't valid.");
  }

  const field = issue.path.join(".");
  if (valueAt(body, [...issue.path]) === undefined) {
    return new ApiError("validation_failed", `Field "${field}" is required.`, { field });
  }
  return new ApiError("validation_failed", `Field "${field}" isn't valid: ${issue.message}.`, { field });
}
