import { z } from "zod";
import { defineShape, shapeQuery } from "@/lib/api/shape";
import { INBOUND_RETENTION_HARD_MAX_DAYS, INBOUND_SUBDOMAIN_DEFAULT, INBOUND_SUBDOMAIN_PATTERN } from "@/lib/inbound/constants";

export const updateInboundSchema = z.object({
  enabled: z.boolean().describe("Whether this domain accepts mail."),
  webhook_url: z
    .string()
    .url()
    .nullable()
    .optional()
    .describe("Where inbound.received is delivered. Required to enable inbound; a fresh URL rotates the signing secret. null removes the endpoint, and can't be combined with enabled: true."),
  retention_days: z
    .number()
    .int()
    .min(1)
    .max(INBOUND_RETENTION_HARD_MAX_DAYS)
    .optional()
    .describe("Days inbound mail is held before it's purged. 7 by default, up to the install's ceiling: 30 unless an admin changed it."),
  subdomain: z
    .string()
    .regex(INBOUND_SUBDOMAIN_PATTERN, "Must be one lowercase DNS label, such as inbound.")
    .optional()
    .describe(`The label mail is addressed to, as in reply@<subdomain>.<domain>. "${INBOUND_SUBDOMAIN_DEFAULT}" by default. Changing it replaces the inbound DNS records.`),
});

export type UpdateInboundRequest = z.output<typeof updateInboundSchema>;

const INBOUND_KEYS = [
  "id",
  "url",
  "domain_id",
  "from",
  "to",
  "subject",
  "text",
  "html",
  "headers",
  "message_id",
  "in_reply_to",
  "outbound_message_id",
  "attachments",
  "raw_download_url",
  "verdicts",
  "address_ids",
  "thread_id",
  "received_at",
  "expires_at",
] as const;

/** An inbound message, wherever the API returns one. */
export const inboundShape = defineShape({
  resource: "inbound message",
  keys: INBOUND_KEYS,
  defaults: INBOUND_KEYS,
  expansions: { body: { keys: ["text", "html"], description: "text and html, read from storage" } },
});

/** `GET /v1/inbound` and `GET /v1/inbound/:id`: the message, plus its domain webhook's delivery on request. */
export const inboundReadShape = defineShape({
  resource: "inbound message",
  keys: [...INBOUND_KEYS, "delivery"],
  defaults: INBOUND_KEYS,
  expansions: {
    body: { keys: ["text", "html"], description: "text and html, read from storage" },
    delivery: { keys: ["delivery"], description: "the newest delivery to the domain's inbound webhook, without its payload, or null" },
  },
});


export const listInboundSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50).describe("How many messages to return, at most 200."),
  cursor: z.string().optional().describe("Id of the last message on the previous page."),
  domain: z.string().optional().describe("Only mail received on this domain id."),
  outbound_message: z.string().optional().describe("Only replies to this sent message id."),
  ...shapeQuery(inboundReadShape),
});
