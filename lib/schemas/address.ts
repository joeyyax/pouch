import { z } from "zod";
import { shapeQuery } from "@/lib/api/shape";
import { addressShape } from "./shapes";
import { attachmentSchema, NO_CONTROL_CHARACTERS } from "./email";
import { inboundShape } from "./inbound";
import {
  ADDRESS_LOCAL_PART_PATTERN,
  ADDRESS_MAX_TTL_SECONDS,
  ADDRESS_MIN_TTL_SECONDS,
  ADDRESS_STATUSES,
  RESERVED_LOCAL_PARTS,
} from "@/lib/addresses/constants";

const localPart = z
  .string()
  .trim()
  .toLowerCase()
  .regex(ADDRESS_LOCAL_PART_PATTERN, "use letters, digits, dots, hyphens and underscores, starting and ending on a letter or digit")
  .refine((value) => !(RESERVED_LOCAL_PARTS as readonly string[]).includes(value), "this local part is reserved for the domain");

const label = z.string().trim().min(1).max(200);
const expiresAt = z.iso.datetime({ offset: true });
const expiresIn = z.number().int().min(ADDRESS_MIN_TTL_SECONDS).max(ADDRESS_MAX_TTL_SECONDS);
const messageCap = z.number().int().min(1).max(1_000_000);

const EXPIRES_AT = "When the address stops delivering, as an ISO 8601 timestamp. Give this or expires_in.";
const EXPIRES_IN = `Seconds from now until the address stops delivering, ${ADDRESS_MIN_TTL_SECONDS} to ${ADDRESS_MAX_TTL_SECONDS}. Give this or expires_at.`;

function oneExpiry(value: { expires_at?: string; expires_in?: number }): boolean {
  return (value.expires_at === undefined) !== (value.expires_in === undefined);
}

export const createAddressSchema = z
  .object({
    domain_id: z.string().min(1).describe("The domain the address lives on. Mail reaches it at <local_part>@<the domain's inbound host>, so inbound has to be enabled."),
    local_part: localPart.optional().describe("The part before the @. Lowercased. Random when omitted. postmaster and abuse stay with the domain."),
    label: label.optional().describe("A note for your own use, such as what the address is for."),
    expires_at: expiresAt.optional().describe(EXPIRES_AT),
    expires_in: expiresIn.optional().describe(EXPIRES_IN),
    message_cap: messageCap.optional().describe("Most messages the address delivers over its life. Mail past it is dropped and counted."),
  })
  .refine(oneExpiry, { message: "Provide exactly one of expires_at or expires_in.", path: ["expires_at"] });
export type CreateAddressRequest = z.output<typeof createAddressSchema>;

export const updateAddressSchema = z
  .object({
    expires_at: expiresAt.optional().describe(`${EXPIRES_AT} An expired address comes back when its expiry moves forward.`),
    expires_in: expiresIn.optional().describe(`Seconds from now until the address stops delivering, ${ADDRESS_MIN_TTL_SECONDS} to ${ADDRESS_MAX_TTL_SECONDS}. Give this or expires_at.`),
    label: label.nullable().optional().describe("A note for your own use. null clears it."),
    message_cap: messageCap.nullable().optional().describe("Most messages the address delivers over its life. null removes the cap."),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "Provide at least one of expires_at, expires_in, label or message_cap.",
  })
  .refine((patch) => !(patch.expires_at !== undefined && patch.expires_in !== undefined), {
    message: "Provide expires_at or expires_in, not both.",
    path: ["expires_at"],
  });
export type UpdateAddressRequest = z.output<typeof updateAddressSchema>;

export const listAddressesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50).describe("How many addresses to return, at most 200."),
  cursor: z.string().optional().describe("Id of the last address on the previous page."),
  domain: z.string().optional().describe("Only addresses on this domain id."),
  status: z.enum(ADDRESS_STATUSES).optional().describe("Only addresses in this status."),
  ...shapeQuery(addressShape),
});
export type ListAddressesRequest = z.output<typeof listAddressesSchema>;

/** Longest a read waits for mail, kept under the 60-second timeout common to MCP clients and proxies. */
export const ADDRESS_WAIT_MAX_SECONDS = 55;

export const listAddressMessagesSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50).describe("How many messages to return, at most 200."),
    cursor: z.string().optional().describe("Id of the last message on the previous page."),
    after: z.string().optional().describe("Only messages received after this message id, for picking up where a previous read stopped."),
    thread: z.string().optional().describe("Only messages in this thread id."),
    wait: z.coerce
      .number()
      .int()
      .min(0)
      .max(ADDRESS_WAIT_MAX_SECONDS)
      .default(0)
      .describe(`Seconds to wait for a message when none matches yet, up to ${ADDRESS_WAIT_MAX_SECONDS}. Returns as soon as one arrives, or an empty page when the time runs out. 0 answers at once.`),
    ...shapeQuery(inboundShape),
  })
  .refine((query) => !(query.wait > 0 && query.cursor !== undefined), {
    message: "wait can't be combined with cursor: a later page is already complete.",
    path: ["wait"],
  });
export type ListAddressMessagesRequest = z.output<typeof listAddressMessagesSchema>;

const MAX_REPLY_CC = 50;

export const replyFromAddressSchema = z
  .object({
    message_id: z.string().min(1).describe("The inbound message to answer, prefixed inb_. It has to have been delivered to this address."),
    subject: z
      .string()
      .min(1)
      .max(998)
      .regex(NO_CONTROL_CHARACTERS, "must not contain line breaks or other control characters")
      .optional()
      .describe('Subject line. "Re: " and the original subject when omitted.'),
    html: z.string().optional().describe("HTML body. At least one of html or text is required."),
    text: z.string().optional().describe("Plain-text body. At least one of html or text is required."),
    cc: z.array(z.string()).max(MAX_REPLY_CC).optional().describe("Carbon-copy addresses. The reply itself goes to the message's Reply-To, or its sender."),
    attachments: z.array(attachmentSchema).max(20).optional().describe("Files to attach, base64-encoded."),
    tags: z.array(z.string().min(1).max(64)).max(20).optional().describe("Free-form tags, filterable in the dashboard."),
  })
  .refine((value) => Boolean(value.html) || Boolean(value.text), {
    message: 'At least one of "html" or "text" is required.',
    path: ["html"],
  });
export type ReplyFromAddressRequest = z.output<typeof replyFromAddressSchema>;

export const addForwardTargetSchema = z.object({
  email: z
    .string()
    .trim()
    .min(3)
    .max(320)
    .describe("The mailbox to forward to. It gets a confirmation link, and nothing forwards until it's opened."),
});
export type AddForwardTargetRequest = z.output<typeof addForwardTargetSchema>;
