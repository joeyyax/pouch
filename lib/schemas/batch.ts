import { z } from "zod";
import { layoutOverrideSchema } from "@/lib/domains/layout";

const MAX_INLINE_RECIPIENTS = 5000;

const recipientSchema = z.object({
  address: z.string().min(3).describe("Recipient address."),
  attributes: z.record(z.string(), z.string()).optional().describe("Flat attribute map substituted into {{name}} placeholders."),
});

export const createBatchSchema = z
  .object({
    from: z.string().min(3).describe("Sender as `Name <address>` or a bare address. The domain must be verified and allow bulk."),
    subject: z.string().min(1).max(998).describe("Subject line. May contain {{name}} placeholders."),
    html: z.string().optional().describe("HTML body. May contain {{name}} placeholders. At least one of html or text is required."),
    text: z.string().optional().describe("Plain-text body. May contain {{name}} placeholders."),
    layout: z.union([z.boolean(), layoutOverrideSchema]).optional().describe("Wrap html in the domain's layout. Default false."),
    tags: z.array(z.string().min(1).max(64)).max(20).optional().describe("Free-form tags, filterable in the dashboard."),
    list: z.string().optional().describe("List id to draw recipients from. Mutually exclusive with recipients."),
    recipients: z.array(recipientSchema).min(1).max(MAX_INLINE_RECIPIENTS).optional().describe("Inline recipients. Mutually exclusive with list."),
  })
  .refine((value) => Boolean(value.html) || Boolean(value.text), {
    message: 'At least one of "html" or "text" is required.',
    path: ["html"],
  })
  .refine((value) => Boolean(value.list) !== Boolean(value.recipients), {
    message: 'Provide exactly one of "list" or "recipients".',
    path: ["list"],
  });

export type CreateBatchRequest = z.output<typeof createBatchSchema>;
