/**
 * The events this increment can emit, and nothing else.
 *
 * Its own file, with no imports, because both sides of the client boundary need it: the schema
 * module that used to hold them pulls in drizzle-orm and every neighboring table, and a value
 * imported from there into a "use client" file drags all of it into the browser bundle.
 *
 * Adding one here means adding its emitter first. `inbound.received` is the one event a
 * domain-scoped endpoint (`domain_id` set) ever carries; everything else is a key-scoped
 * endpoint's (`api_key_id` set) own allow-list.
 */
export const WEBHOOK_EVENT_TYPES = [
  "email.delivered",
  "email.bounced",
  "email.complained",
  "email.unsubscribed",
  "list.subscribed",
  "inbound.received",
  "address.received",
  "domain.reputation_changed",
  "organization.reputation_changed",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** What a key-scoped endpoint may subscribe to. Derived, so a new event type can't be forgotten here. */
export const KEY_WEBHOOK_EVENT_TYPES = WEBHOOK_EVENT_TYPES.filter((type) => type !== "inbound.received");
