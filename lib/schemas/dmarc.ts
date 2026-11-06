import { z } from "zod";
import { shapeQuery } from "@/lib/api/shape";
import { dmarcReportShape } from "./shapes";

export const listDmarcReportsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50).describe("How many reports to return, at most 200."),
  cursor: z.string().optional().describe("Id of the last report on the previous page."),
  ...shapeQuery(dmarcReportShape),
});
