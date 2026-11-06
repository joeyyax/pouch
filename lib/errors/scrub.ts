import type { ErrorEvent, EventHint, StackFrame } from "@sentry/node";

/**
 * What a reported error may carry beyond class, message and stack. An allowlist: a field added
 * here later has to be argued for, where a denylist would ship a new PII field to GlitchTip the
 * day someone adds it without remembering this file exists.
 */
export interface ErrorContext {
  route?: string;
  routeType?: string;
  method?: string;
  statusCode?: number;
  errorCode?: string;
  messageId?: string;
  organizationId?: string;
  domainId?: string;
  providerId?: string;
  providerAdapter?: string;
  requestId?: string;
  workerId?: string;
  /** Next's hash of a server render error, which matches the server log line. */
  digest?: string;
}

const ALLOWED_KEYS = [
  "route",
  "routeType",
  "method",
  "statusCode",
  "errorCode",
  "messageId",
  "organizationId",
  "domainId",
  "providerId",
  "providerAdapter",
  "requestId",
  "workerId",
  "digest",
] as const satisfies readonly (keyof ErrorContext)[];

/** Drops any field not on the allowlist, so an unreviewed field can't ride along silently. */
export function allowlistContext(context: ErrorContext | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!context) return out;
  for (const key of ALLOWED_KEYS) {
    const value = context[key];
    if (value !== undefined && value !== null) out[key] = String(value);
  }
  return out;
}

// A recipient, sender or reply-to address in a message, a stack trace or a driver error.
const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Bearer tokens, API keys and provider credentials that end up in an Authorization header,
// a fetch error, or a query parameter string.
const CREDENTIAL_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._-]{10,}/gi,
  /\b[A-Za-z0-9_-]*(?:key|token|secret)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{10,}/gi,
  // AWS-style access keys.
  /\bAKIA[0-9A-Z]{16}\b/g,
];

// A subject line or body fragment quoted or parenthesized into an error message — a provider's
// bounce reason ("Provider reasons, verbatim", per lib/providers/adapters/types.ts) is the expected case,
// but this is a backstop for any message, ours or a dependency's, that does the same. Only spans
// with a space are touched, so a short identifier in quotes (a header name, a domain) survives.
const QUOTED_PHRASE = /(["'`])((?:(?!\1)[\s\S])*\s(?:(?!\1)[\s\S])*)\1/g;
const PARENTHESIZED_PHRASE = /\(([^()]*\s[^()]*)\)/g;

/**
 * Redacts anything that looks like an address, a credential, or free text a caller controlled.
 * Applied to every text field before send. Regex can prove a span IS one of these shapes; it
 * can't prove a span ISN'T PII, which is why this stays a backstop and not the only guard — see
 * `lib/errors/report.ts` for why call sites shouldn't hand this function message content to catch.
 */
export function redactText(value: string): string {
  let out = value.replace(EMAIL, "[redacted-address]");
  for (const pattern of CREDENTIAL_PATTERNS) out = out.replace(pattern, "[redacted-credential]");
  out = out.replace(QUOTED_PHRASE, "$1[redacted-text]$1");
  out = out.replace(PARENTHESIZED_PHRASE, "([redacted-text])");
  return out;
}

function redactFrame(frame: StackFrame): StackFrame {
  // Local variables captured in a frame are exactly the recipient/subject/body values this
  // exists to keep out, so `vars` is dropped outright rather than redacted piecemeal. Source
  // context lines and the filename are layout, not data, but get redacted too in case a bound
  // template literal ever puts a value in a line of source.
  const { vars: _vars, ...rest } = frame;
  return {
    ...rest,
    ...(frame.context_line ? { context_line: redactText(frame.context_line) } : {}),
    ...(frame.pre_context ? { pre_context: frame.pre_context.map(redactText) } : {}),
    ...(frame.post_context ? { post_context: frame.post_context.map(redactText) } : {}),
  };
}

/**
 * The last line of defense before an event leaves the process. Rebuilds it from an allowlist of
 * top-level fields and redacts every text field that survives, so a future change to what we
 * capture — a new integration, a richer context object — still can't ship a raw address, subject,
 * body or credential.
 */
export function scrubEvent(event: ErrorEvent, _hint?: EventHint): ErrorEvent | null {
  const exception = event.exception
    ? {
        values: event.exception.values?.map((value) => ({
          ...value,
          value: value.value ? redactText(value.value) : value.value,
          stacktrace: value.stacktrace ? { frames: value.stacktrace.frames?.map(redactFrame) } : undefined,
        })),
      }
    : undefined;

  return {
    type: event.type,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    release: event.release,
    environment: event.environment,
    server_name: event.server_name,
    message: event.message ? redactText(event.message) : undefined,
    exception,
    // Only our own allowlisted context, already stripped of anything but string values.
    tags: event.tags,
    contexts: event.contexts?.pouch ? { pouch: event.contexts.pouch } : undefined,
    // No request, no user, no breadcrumbs, no extra: never populated because nothing upstream
    // of this function sets them (see lib/errors/report.ts), and dropped here again in case it
    // ever does.
    request: undefined,
    user: undefined,
    breadcrumbs: undefined,
    extra: undefined,
  };
}

/** postgres-js names its own class; drizzle wraps it and puts the query and params in `message`. */
interface DriverError {
  name?: string;
  code?: string;
  constraint_name?: string;
  table_name?: string;
}

/**
 * An error's message, with anything a database driver attaches to it left out. A postgres-js
 * error carries the offending row in `detail`, and drizzle's wrapper puts the query and its
 * parameters in the message itself — both hold recipient addresses. Use this anywhere an error
 * reaches a log line or a stored reason.
 */
export function safeErrorMessage(error: unknown): string {
  for (const candidate of [error, (error as { cause?: unknown } | undefined)?.cause]) {
    const driver = candidate as DriverError | undefined;
    if (driver?.name !== "PostgresError") continue;
    const where = driver.constraint_name ?? driver.table_name;
    return `database error ${driver.code ?? "unknown"}${where ? ` on ${where}` : ""}`;
  }
  if ((error as DriverError | undefined)?.name === "DrizzleQueryError") return "database error";
  return error instanceof Error ? error.message : String(error);
}
