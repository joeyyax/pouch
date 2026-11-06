import { z } from "zod";
import { shapeQuery } from "@/lib/api/shape";
import { exportShape } from "./shapes";
import { EXPORT_KINDS } from "@/lib/db/schema/exports";
import { MESSAGE_STATUSES } from "@/lib/db/schema/messages";

/**
 * Filters mirror listMessagesSchema's own field names and shape (lib/schemas/message.ts) —
 * the same "status, domain, tag, since, until" vocabulary docs/api/conventions.md's Filtering
 * section already documents for GET /v1/emails. Ignored entirely when kind is `data`, which
 * exports the whole organization's suppressions and domain configuration.
 */
export const createExportSchema = z.object({
  kind: z.enum(EXPORT_KINDS).describe("What to export: log_csv, log_ndjson, bodies or data."),
  status: z.enum(MESSAGE_STATUSES).optional().describe("Only messages with this status. Ignored when kind is data."),
  domain: z.string().optional().describe("Only messages sent from this domain id. Ignored when kind is data."),
  tag: z.string().optional().describe("Only messages carrying this tag. Ignored when kind is data."),
  since: z.coerce.date().optional().describe("Only messages created at or after this ISO 8601 timestamp. Ignored when kind is data."),
  until: z.coerce.date().optional().describe("Only messages created at or before this ISO 8601 timestamp. Ignored when kind is data."),
});

export type CreateExportRequest = z.output<typeof createExportSchema>;

export const listExportsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50).describe("How many exports to return, at most 200."),
  cursor: z.string().optional().describe("Id of the last export on the previous page."),
  ...shapeQuery(exportShape),
});
