import { customAlphabet } from "nanoid";

/** Header carrying the request id, honored inbound and always set on the response. */
export const REQUEST_ID_HEADER = "x-request-id";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const random = customAlphabet(ALPHABET, 24);

/** Loose enough for UUIDs, ULIDs and typical trace ids; tight enough to log without escaping. */
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Uses the caller's X-Request-Id when it fits the bound, otherwise mints one. */
export function resolveRequestId(request: Request): string {
  const inbound = request.headers.get(REQUEST_ID_HEADER)?.trim();
  return inbound && VALID_REQUEST_ID.test(inbound) ? inbound : `req_${random()}`;
}
