import { z } from "zod";
import { MESSAGE_STATUSES, type MessageStatus } from "@/lib/db/schema/messages";
import { defineShape, shapeQuery } from "@/lib/api/shape";

const MESSAGE_KEYS = [
  "id",
  "url",
  "status",
  "from",
  "to",
  "cc",
  "bcc",
  "reply_to",
  "subject",
  "tags",
  "headers",
  "layout",
  "key_id",
  "batch_id",
  "test_mode",
  "sensitive",
  "warnings",
  "provider_message_id",
  "reason",
  "attempts",
  "next_attempt_at",
  "created_at",
  "sent_at",
  "delivered_at",
  "abandoned_at",
  "size",
  "resent_from",
] as const;

const BODY = {
  keys: ["body", "body_unavailable"],
  description: "html, text and attachments with download links that expire, or null and why",
} as const;
const RENDERED = {
  keys: ["rendered", "body_unavailable"],
  description: "the html as the recipient got it, framed in the domain's layout, or null and why",
} as const;
const EVENTS = { keys: ["events"], description: "every lifecycle transition, oldest first" } as const;
const OCCURRENCES = {
  keys: ["occurrences"],
  description: "what happened without changing the status: retries, backoffs, suppressions, a shredded body, webhook deliveries, oldest first",
} as const;

const RESENDS = { keys: ["resends"], description: "the copies resent from this message, oldest first" } as const;

/** A message on `GET /v1/emails`. */
export const messageListShape = defineShape({
  resource: "message",
  keys: [...MESSAGE_KEYS, "events", "occurrences", "body", "rendered", "body_unavailable", "resends"],
  defaults: MESSAGE_KEYS,
  expansions: { events: EVENTS, occurrences: OCCURRENCES, body: BODY, rendered: RENDERED, resends: RESENDS },
});

/** A message on `GET /v1/emails/:id`. */
export const messageReadShape = defineShape({
  resource: "message",
  keys: [...MESSAGE_KEYS, "events", "occurrences", "stall", "body", "rendered", "body_unavailable", "resends"],
  defaults: [...MESSAGE_KEYS, "events", "stall", "resends"],
  expansions: {
    events: EVENTS,
    occurrences: OCCURRENCES,
    stall: { keys: ["stall"], description: "what holds a queued message, or null" },
    body: BODY,
    rendered: RENDERED,
    resends: RESENDS,
  },
});

/** A comma-separated list of statuses. One status reads as it always has. */
export const statusList = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined) return undefined;
    const names = [...new Set(raw.split(",").map((part) => part.trim()).filter(Boolean))];
    if (names.length === 0) return undefined;
    const unknown = names.filter((name) => !(MESSAGE_STATUSES as readonly string[]).includes(name));
    if (unknown.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `Unknown status ${unknown.map((name) => `"${name}"`).join(", ")}. Valid values: ${MESSAGE_STATUSES.join(", ")}.`,
        params: { unknown, valid: [...MESSAGE_STATUSES] },
      });
      return z.NEVER;
    }
    return names as MessageStatus[];
  })
  .describe(`Only messages with one of these statuses, comma-separated: ${MESSAGE_STATUSES.join(", ")}.`);

export const listMessagesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50).describe("How many messages to return, at most 200."),
  cursor: z.string().optional().describe("Id of the last message on the previous page."),
  status: statusList,
  domain: z.string().optional().describe("Only messages sent from this domain id."),
  key: z.string().optional().describe("Only messages sent with this key id."),
  batch: z.string().optional().describe("Only messages sent in this batch id."),
  held: z
    .enum(["true", "false"])
    .optional()
    .describe("true for queued messages a paused domain or a suspended organization is holding, false for the rest. Omit for both."),
  sensitive: z
    .enum(["true", "false"])
    .optional()
    .describe("true for messages whose body is withheld from every read, false for the rest. Omit for both."),
  tag: z.string().optional().describe("Only messages carrying this tag."),
  to: z.string().min(3).optional().describe("Only messages to this address, in to, cc or bcc, matched on its normalized form."),
  reason: z.string().min(1).optional().describe("Only messages with a bounce or complaint carrying exactly this reason, as the provider gave it."),
  since: z.coerce.date().optional().describe("Only messages created at or after this ISO 8601 timestamp."),
  until: z.coerce.date().optional().describe("Only messages created at or before this ISO 8601 timestamp."),
  ...shapeQuery(messageListShape),
});
