import { z } from "zod";
import { shapeQuery } from "@/lib/api/shape";
import { suppressionShape } from "./shapes";
import { SUPPRESSION_REASONS } from "@/lib/db/schema/suppressions";

/** Rows one `POST /v1/suppressions` call takes. */
export const SUPPRESSION_IMPORT_LIMIT = 5000;

export const SUPPRESSION_SOURCE_MAX = 100;

export const listSuppressionsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50).describe("How many suppressions to return, at most 200."),
  cursor: z.string().optional().describe("Id of the last suppression on the previous page."),
  reason: z.enum(SUPPRESSION_REASONS).optional().describe("Only suppressions with this reason."),
  address: z.string().min(3).optional().describe("Only this address, matched on its normalized form."),
  domain: z.string().optional().describe("Only suppressions caused by a message sent from this domain id."),
  since: z.coerce.date().optional().describe("Only suppressions added at or after this ISO 8601 timestamp."),
  until: z.coerce.date().optional().describe("Only suppressions added at or before this ISO 8601 timestamp."),
  ...shapeQuery(suppressionShape),
});

const reasonSchema = z.enum(SUPPRESSION_REASONS);
const sourceSchema = z.string().trim().min(1).max(SUPPRESSION_SOURCE_MAX);

export const importSuppressionsSchema = z.object({
  suppressions: z
    .array(
      z.object({
        address: z.string().describe("Address to suppress. The domain part is lowercased; the local part is kept."),
        reason: reasonSchema.optional().describe("This row's reason. Defaults to the top-level reason."),
        detail: z.string().max(1000).optional().describe("Why it's suppressed, such as the old provider's bounce text."),
      }),
    )
    .min(1)
    .max(SUPPRESSION_IMPORT_LIMIT)
    .describe(`Addresses to suppress, at most ${SUPPRESSION_IMPORT_LIMIT} per call.`),
  reason: reasonSchema.default("manual").describe("Reason for any row that doesn't set its own: hard_bounce, complaint or manual."),
  source: sourceSchema.optional().describe("Where the list came from, such as postmark. Stored on every row this call adds. Default api."),
});
export type ImportSuppressionsRequest = z.output<typeof importSuppressionsSchema>;

/** Query string for a `text/csv` body, which has nowhere else to carry them. */
export const importSuppressionsCsvQuerySchema = z.object({
  reason: reasonSchema.default("manual").describe("Reason for any row without a reason column value."),
  source: sourceSchema.optional().describe("Where the list came from. Default api."),
});
