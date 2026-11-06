/**
 * Google's Gmail feedback loop header: `a:b:c:SenderId`, colon-separated, with a mandatory
 * 5-15 character SenderId last. https://support.google.com/mail/answer/6254652
 */
import { brand } from "@/lib/brand";

const HEADER_NAME = "Feedback-ID";
const HEADER_NAME_LOWER = "feedback-id";

/** Stable across every send — Google requires the SenderId field never change. */
const SENDER_ID = brand.name.toLowerCase();

export type MailType = "transactional" | "bulk";

function hasFeedbackId(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === HEADER_NAME_LOWER);
}

/** Organization id, then mail type, then the stable sender id — organization is what #297 reads the per-organization spam rate back out by. */
export function buildFeedbackId(organizationId: string, mailType: MailType): string {
  return `${organizationId}:${mailType}:${SENDER_ID}`;
}

/**
 * Adds Feedback-ID unless the caller already set one (case-insensitive) or the provider drops
 * custom headers in transit — see docs/decisions.md, "A compliance header only counts if the
 * provider will carry it."
 */
export function withFeedbackId(
  headers: Record<string, string>,
  organizationId: string,
  mailType: MailType,
  providerCarriesHeaders: boolean,
): Record<string, string> {
  if (!providerCarriesHeaders) return headers;
  if (hasFeedbackId(headers)) return headers;
  return { ...headers, [HEADER_NAME]: buildFeedbackId(organizationId, mailType) };
}
