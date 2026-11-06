import { z } from "zod";
import { shapeQuery } from "@/lib/api/shape";
import { ACTIVITY_FAMILIES, ACTIVITY_OUTCOMES } from "@/lib/db/schema/activity";
import { activityShape } from "./shapes";

/** A comma-separated list checked against `valid`, unknown names reported the way `include` reports them. */
function nameList<const T extends string>(name: string, valid: readonly T[], description: string) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined) return undefined;
      const names = [...new Set(raw.split(",").map((part) => part.trim()).filter(Boolean))];
      if (names.length === 0) return undefined;
      const unknown = names.filter((value) => !(valid as readonly string[]).includes(value));
      if (unknown.length > 0) {
        ctx.addIssue({
          code: "custom",
          message: `Unknown ${name} ${unknown.map((value) => `"${value}"`).join(", ")}. Valid values: ${valid.join(", ")}.`,
          params: { unknown, valid: [...valid] },
        });
        return z.NEVER;
      }
      return names as T[];
    })
    .describe(description);
}

export const listActivitySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50).describe("How many entries to return, at most 200."),
  cursor: z.string().optional().describe("Id of the last entry on the previous page."),
  family: nameList("family", ACTIVITY_FAMILIES, `Only these families, comma-separated: ${ACTIVITY_FAMILIES.join(", ")}.`),
  outcome: nameList("outcome", ACTIVITY_OUTCOMES, `Only these outcomes, comma-separated: ${ACTIVITY_OUTCOMES.join(", ")}.`),
  actor: z
    .string()
    .optional()
    .transform((raw) => [...new Set((raw ?? "").split(",").map((part) => part.trim()).filter(Boolean))])
    .describe("Only these actors, comma-separated as type:id from an entry's actor, or type:label for the worker, which has no id."),
  since: z.coerce.date().optional().describe("Only entries at or after this ISO 8601 timestamp."),
  ...shapeQuery(activityShape),
});
