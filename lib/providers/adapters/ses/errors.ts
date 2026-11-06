import type { AdapterHealth } from "../types";

export const NOT_FOUND_NAMES = new Set(["NotFoundException"]);

/** Swallows "it isn't there", so a teardown can be run again. */
export async function tolerateMissing<T>(pending: Promise<T>): Promise<T | null> {
  try {
    return await pending;
  } catch (err) {
    if (NOT_FOUND_NAMES.has((err as Error).name)) return null;
    throw err;
  }
}

export const EXISTS_NAMES = new Set(["AlreadyExistsException", "ResourceAlreadyExistsException"]);

/** Swallows the "it's already there" error, so a half-finished setup can be run again. */
export async function tolerateExisting<T>(pending: Promise<T>): Promise<T | null> {
  try {
    return await pending;
  } catch (err) {
    if (EXISTS_NAMES.has((err as Error).name)) return null;
    throw err;
  }
}

// LimitExceededException is a resource count, not a rate: https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html
export const THROTTLE_NAMES = new Set(["ThrottlingException", "TooManyRequestsException"]);
// SES's documented sending-limit messages: https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas-errors.html
export const QUOTA_MESSAGE = /maximum sending rate exceeded|daily message quota exceeded/i;
export const DAILY_QUOTA_MESSAGE = /daily message quota exceeded/i;
export const PAUSE_NAMES = new Set(["SendingPausedException", "AccountSuspendedException"]);
export const AUTH_NAMES = new Set([
  "UnrecognizedClientException",
  "InvalidClientTokenId",
  "InvalidSignatureException",
  "SignatureDoesNotMatch",
  "IncompleteSignature",
  "ExpiredTokenException",
]);
export const MAIL_FROM_NAME = "MailFromDomainNotVerifiedException";
export const ACCESS_DENIED_NAMES = new Set(["AccessDenied", "AccessDeniedException"]);

export function isAccessDenied(err: unknown): boolean {
  const name = (err as Error).name;
  return ACCESS_DENIED_NAMES.has(name) || (statusOf(err) === 403 && !AUTH_NAMES.has(name));
}

/** Names the missing action, rather than reporting a permission error as an outage. */
export function accessDeniedDetail(err: unknown): string | null {
  if (!ACCESS_DENIED_NAMES.has((err as Error).name)) return null;
  const action = reasonOf(err).match(/perform:?\s*([a-zA-Z0-9:_-]+)/)?.[1];
  return action ? `Credentials are valid but missing the ${action} permission.` : "Credentials are valid but missing a required permission.";
}

/** Retries and waits for a non-send SES call. Mutable for tests. */
export const API_RETRY = { attempts: 4, baseMs: Number(process.env.SES_API_RETRY_BASE_MS) || 1_000, maxWaitMs: 10_000 };

/** No non-send permit came in time. */
export class ApiRateTimeoutError extends Error {
  constructor(subject: string) {
    super(`No SES API permit for ${subject} within ${API_RETRY.maxWaitMs}ms.`);
    this.name = "ApiRateTimeoutError";
  }
}

export function isThrottle(err: unknown): boolean {
  return (
    err instanceof ApiRateTimeoutError || THROTTLE_NAMES.has((err as Error).name) || statusOf(err) === 429 || QUOTA_MESSAGE.test(reasonOf(err))
  );
}

export const THROTTLED: AdapterHealth = { ok: null, detail: "Rate limited by the provider.", throttled: true };

export function statusOf(error: unknown): number {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode ?? 0;
}

export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
