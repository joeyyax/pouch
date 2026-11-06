import type { ErrorCode } from "@/lib/api/errors";
import { ApiError } from "@/lib/api/errors";

/**
 * Which `ErrorCode`s are worth a sender retrying. Everything else is permanent: the request
 * as sent will never succeed, so a client that retries it verbatim forever is worse than a
 * bounce. Kept as an explicit allowlist rather than deriving from the HTTP status (422 and 503
 * both need to land on opposite sides of this line) — see the PR body for the mapping.
 */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set(["rate_limit_exceeded", "stream_limit_exceeded", "provider_unavailable"]);

/** SMTP reply code overrides for codes that have a conventional one. Everything else falls
 * back to 550 (permanent) or 450 (retryable) by membership in RETRYABLE above. */
const REPLY_CODE_OVERRIDES: Partial<Record<ErrorCode, number>> = {
  invalid_key: 535,
  attachment_too_large: 552,
  rate_limit_exceeded: 450,
  stream_limit_exceeded: 450,
  provider_unavailable: 451,
};

export interface SmtpReply {
  /** SMTP reply code: 4xx is worth retrying, 5xx is permanent. */
  code: number;
  /** The API's own error message, so a sender sees the same text an HTTP caller would. */
  message: string;
}

/** Maps an ApiError to the SMTP reply a sender gets back, the API message as its text. */
export function smtpReplyFor(error: ApiError): SmtpReply {
  const code = REPLY_CODE_OVERRIDES[error.code] ?? (RETRYABLE.has(error.code) ? 450 : 550);
  return { code, message: error.message };
}

/** An Error subclass carrying an SMTP reply code, the shape `smtp-server` reads back to the client. */
export class SmtpProtocolError extends Error {
  readonly responseCode: number;

  constructor(reply: SmtpReply) {
    super(reply.message);
    this.name = "SmtpProtocolError";
    this.responseCode = reply.code;
  }
}

/** Converts any thrown value into the SMTP-flavored error `smtp-server` sends back to the client. */
export function toSmtpError(error: unknown): SmtpProtocolError {
  if (error instanceof ApiError) return new SmtpProtocolError(smtpReplyFor(error));
  // Not an API rejection — the service's own fault, not the sender's message. Retryable.
  return new SmtpProtocolError({ code: 451, message: "The service can't complete this request right now." });
}
