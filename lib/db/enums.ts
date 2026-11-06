/**
 * Enum values a screen reads at runtime, with no imports, so a page or client component can use
 * them without reaching the schema. The schema re-exports each one.
 */

export const MESSAGE_STATUSES = ["queued", "sent", "delivered", "deferred", "bounced", "complained", "failed"] as const;

export const MEMBERSHIP_STATUSES = ["pending", "subscribed", "unsubscribed"] as const;

export const SUPPRESSION_REASONS = ["hard_bounce", "complaint", "manual"] as const;
