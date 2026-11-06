/** `revoked` is final. `expired` comes back to `active` when the expiry moves forward. */
export const ADDRESS_STATUSES = ["active", "expired", "revoked"] as const;
export type AddressStatus = (typeof ADDRESS_STATUSES)[number];

/** Active addresses an organization may hold, absent an operator's setting or an override. */
export const ADDRESS_LIMIT_DEFAULT = 500;

/** Messages one address may receive per UTC day, absent an operator's setting or an override. */
export const ADDRESS_DAILY_MESSAGE_LIMIT_DEFAULT = 100;

export const ADDRESS_MIN_TTL_SECONDS = 60;
export const ADDRESS_MAX_TTL_SECONDS = 365 * 24 * 60 * 60;

/** Lowercase letters, digits, dots, hyphens and underscores, starting and ending on a letter or digit. */
export const ADDRESS_LOCAL_PART_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

/** RFC 2142 mailboxes stay with the domain. */
export const RESERVED_LOCAL_PARTS = ["postmaster", "abuse"] as const;

export const RANDOM_LOCAL_PART_LENGTH = 16;

/** `pending` until the mailbox confirms; `disabled` after a hard bounce, a complaint or a stop link. */
export const FORWARD_TARGET_STATUSES = ["pending", "confirmed", "disabled"] as const;
export type ForwardTargetStatus = (typeof FORWARD_TARGET_STATUSES)[number];

export const FORWARD_DISABLED_REASONS = ["bounced", "complained", "stopped"] as const;
export type ForwardDisabledReason = (typeof FORWARD_DISABLED_REASONS)[number];

/** One forward of one message to one target. */
export const FORWARD_STATUSES = ["pending", "sent", "failed", "skipped"] as const;
export type ForwardStatus = (typeof FORWARD_STATUSES)[number];

/** Forward targets one address may hold. */
export const FORWARD_TARGET_LIMIT = 5;

/** Unconfirmed targets an organization may hold at once, which bounds confirmation mail to strangers. */
export const FORWARD_PENDING_LIMIT = 20;

export const FORWARD_CONFIRM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
