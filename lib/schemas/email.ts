import { z } from "zod";
import { layoutOverrideSchema } from "@/lib/domains/layout";

/** Ceiling on recipients in one list. The domain's provider may allow fewer. */
const MAX_RECIPIENTS = 50;

/** No line breaks or other control characters, so a field can't inject extra header lines. */
export const NO_CONTROL_CHARACTERS = /^[^\x00-\x1F\x7F\u0085\u2028\u2029]*$/;

function addressList(constraints: { min?: number; max: number }) {
  return z
    .union([z.string(), z.array(z.string())])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .pipe(z.array(z.string()).min(constraints.min ?? 0).max(constraints.max));
}

export const attachmentSchema = z.object({
  filename: z.string().min(1).max(255).describe("File name shown to the recipient."),
  content: z.string().min(1).describe("Base64-encoded file content."),
  content_type: z.string().min(1).max(255).describe("MIME type of the attachment."),
});

export const sendEmailSchema = z
  .object({
    from: z.string().min(3).describe("Sender as `Name <address>` or a bare address. The domain must be verified and in the key's scope."),
    to: addressList({ min: 1, max: MAX_RECIPIENTS }).describe("One or more recipient addresses."),
    cc: addressList({ max: MAX_RECIPIENTS }).optional().describe("One or more carbon-copy addresses."),
    bcc: addressList({ max: MAX_RECIPIENTS }).optional().describe("One or more blind carbon-copy addresses."),
    reply_to: addressList({ max: MAX_RECIPIENTS }).optional().describe("One or more reply-to addresses."),
    subject: z
      .string()
      .min(1)
      .max(998)
      .regex(NO_CONTROL_CHARACTERS, "must not contain line breaks or other control characters")
      .describe("Subject line."),
    html: z.string().optional().describe("HTML body. At least one of html or text is required."),
    text: z.string().optional().describe("Plain-text body. At least one of html or text is required."),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe("Custom headers. Reserved headers are rejected. Mailpace domains reject custom headers entirely."),
    tags: z.array(z.string().min(1).max(64)).max(20).optional().describe("Free-form tags, filterable in the dashboard."),
    attachments: z.array(attachmentSchema).max(20).optional().describe("Files to attach, base64-encoded."),
    layout: z
      .union([z.boolean(), layoutOverrideSchema])
      .optional()
      .describe(
        "Wrap html in the domain's layout. The domain must have one. true uses it as configured; an object of name, logo, accent and footer overrides those fields for this send only, falling back to the domain's value for anything omitted. Default false.",
      ),
    subscribe: z
      .array(z.string().min(1))
      .max(20)
      .optional()
      .describe(
        "List ids to add every address in `to` to, as an `api` membership recording this message's id. Each list must be on the sending domain. This is the only door a send can grow a list through — omit it and a send never touches a list.",
      ),
    sensitive: z
      .boolean()
      .optional()
      .describe(
        "Withhold the body from every read: the API, MCP, exports and the dashboard. Its key is shredded once it leaves the queue, and it can't be resent. Default false.",
      ),
  })
  .refine((value) => Boolean(value.html) || Boolean(value.text), {
    message: 'At least one of "html" or "text" is required.',
    path: ["html"],
  });

export type SendEmailInput = z.input<typeof sendEmailSchema>;
export type SendEmailRequest = z.output<typeof sendEmailSchema>;

/** Headers the service sets itself. A request carrying one of these is rejected. */
export const RESERVED_HEADERS = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "reply-to",
  "date",
  "message-id",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "dkim-signature",
  "return-path",
  "received",
]);

/**
 * The one custom header the API assigns meaning to: it clears a fan-out hold, so a caller
 * has to be able to set it. list-unsubscribe-post stays a plain custom header here too —
 * `POST /v1/batches` (#7) generates and signs its own one-click unsubscribe link per recipient,
 * but that route takes no `headers` field at all, so there's nothing to reserve on this one.
 */
export const LIST_UNSUBSCRIBE_HEADER = "list-unsubscribe";
