export const ERROR_CODES = {
  invalid_json: 400,
  invalid_key: 401,
  invalid_signature: 401,
  key_not_scoped: 403,
  admin_key_required: 403,
  organization_key_required: 403,
  admin_scope_not_allowed: 403,
  insufficient_role: 403,
  organization_suspended: 403,
  feature_disabled: 403,
  not_found: 404,
  invalid_token: 404,
  method_not_allowed: 405,
  idempotency_conflict: 409,
  validation_failed: 422,
  recipient_suppressed: 422,
  domain_not_verified: 422,
  reserved_header: 422,
  list_unsubscribe_required: 422,
  bulk_not_allowed: 422,
  attachment_too_large: 422,
  provider_limit: 422,
  domain_exists: 422,
  domain_unavailable: 422,
  domain_not_at_provider: 422,
  domain_in_use: 422,
  capability_unavailable: 422,
  provider_exists: 422,
  provider_in_use: 422,
  organization_in_use: 422,
  provider_unassigned: 422,
  credentials_rejected: 422,
  inbound_disabled: 422,
  address_exists: 422,
  address_limit_reached: 422,
  address_inactive: 422,
  reply_not_allowed: 422,
  forward_not_allowed: 422,
  forward_target_exists: 422,
  forward_target_limit_reached: 422,
  forward_target_not_pending: 422,
  resend_not_allowed: 422,
  rate_limit_exceeded: 429,
  stream_limit_exceeded: 429,
  provider_unavailable: 503,
  storage_unavailable: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    field?: string;
    detail?: Record<string, unknown>;
    request_id?: string;
  };
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly field: string | undefined;
  readonly detail: Record<string, unknown> | undefined;
  readonly headers: Record<string, string>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { field?: string; detail?: Record<string, unknown>; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.field = options.field;
    this.detail = options.detail;
    this.headers = options.headers ?? {};
  }

  get status(): number {
    return ERROR_CODES[this.code];
  }

  toBody(requestId?: string): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.field ? { field: this.field } : {}),
        ...(this.detail ? { detail: this.detail } : {}),
        ...(requestId ? { request_id: requestId } : {}),
      },
    };
  }
}
