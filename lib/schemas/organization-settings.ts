import { z } from "zod";
import { SETTINGS } from "@/lib/settings/registry";

export const updateOrganizationSettingsSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional().describe("Display name for the organization."),
    body_retention_days: z.coerce
      .number()
      .int()
      .min(7)
      .max(SETTINGS.body_retention_max_days.max)
      .optional()
      .describe(
        "Days a message body stays readable before the worker shreds its key. 7 up to body_retention_max_days, the install's ceiling: 365 unless an admin changed it.",
      ),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "Provide at least one of name or body_retention_days.",
  });

export type UpdateOrganizationSettingsRequest = z.output<typeof updateOrganizationSettingsSchema>;
