import { z } from "zod";

/** Slug validation matches what `organizations.slug` accepts: lowercase letters, numbers and
 * hyphens, blank meaning "derive one from the name". */
export const createOrganizationSchema = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(100),
  slug: z
    .string()
    .trim()
    .max(100)
    .regex(/^[a-z0-9-]*$/, "Slug can only contain lowercase letters, numbers and hyphens.")
    .optional(),
});

export type CreateOrganizationRequest = z.output<typeof createOrganizationSchema>;
