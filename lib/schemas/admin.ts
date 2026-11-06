import { z, ZodError } from "zod";
import { shapeQuery } from "@/lib/api/shape";
import { accountShape, adminOrganizationShape, adminProviderShape, assignmentShape, memberShape } from "./shapes";
import { ADAPTER_KEYS } from "@/lib/providers/adapters";
import { ORG_ROLES } from "@/lib/auth/permissions";
import { validationError } from "./validation-error";

const CREDENTIALS = z
  .record(z.string(), z.string())
  .describe("Adapter-specific credentials. Checked live before they're stored, and never returned.");

const SETTINGS = z
  .record(z.string(), z.string())
  .describe("Adapter-specific non-secret config, such as a webhook public key. Only providers serving one organization take it.");

const CONCURRENCY = z.coerce.number().int().min(1).max(1000);

const LIMIT = z.coerce.number().int().min(1).max(200).default(50);

export const listAdminProvidersSchema = z.object({
  limit: LIMIT.describe("How many providers to return, at most 200."),
  cursor: z.string().optional().describe("Id of the last provider on the previous page."),
  status: z
    .literal("attention")
    .optional()
    .describe("attention returns only providers whose status isn't ready."),
  ...shapeQuery(adminProviderShape),
});

export const createAdminProviderSchema = z.object({
  adapter: z
    .string()
    .refine((value) => (ADAPTER_KEYS as string[]).includes(value), `Provide a known provider adapter: ${ADAPTER_KEYS.join(", ")}.`)
    .describe("Provider adapter: ses, mailpace, cloudflare or mock."),
  name: z.string().trim().min(1).max(200).describe("Label for this provider, unique among the providers in its organization."),
  credentials: CREDENTIALS,
  settings: SETTINGS.optional(),
  concurrency: CONCURRENCY.optional().describe("Concurrent sends allowed against this provider. Defaults to 16."),
  organization_id: z
    .string()
    .min(1)
    .optional()
    .describe("The one organization an adapter that can't be shared serves. Required for those adapters, refused for SES."),
});

export type CreateAdminProviderRequest = z.output<typeof createAdminProviderSchema>;

export const patchAdminProviderSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional().describe("New label for this provider."),
    concurrency: CONCURRENCY.optional().describe("Concurrent sends allowed. On a shared provider, every organization's assignment gets it too."),
    settings: SETTINGS.optional(),
    credentials: CREDENTIALS.optional(),
    default_for_new_organizations: z
      .boolean()
      .optional()
      .describe("Whether new organizations are assigned this provider. At most one provider has it; setting it clears it elsewhere."),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), "Provide at least one field to change.");

export type PatchAdminProviderRequest = z.output<typeof patchAdminProviderSchema>;

export const listProviderOrganizationsSchema = z.object({
  limit: LIMIT.describe("How many assignments to return, at most 200."),
  cursor: z.string().optional().describe("provider_id of the last assignment on the previous page."),
  ...shapeQuery(assignmentShape),
});

export const assignOrganizationSchema = z.object({
  organization_id: z.string().min(1).describe("The organization to assign this provider to."),
  default: z
    .boolean()
    .optional()
    .describe("Make it the organization's default provider. Defaults to true when the organization has none."),
});

export const listAdminOrganizationsSchema = z.object({
  limit: LIMIT.describe("How many organizations to return, at most 200."),
  cursor: z.string().optional().describe("Id of the last organization on the previous page."),
  ...shapeQuery(adminOrganizationShape),
});

export const patchAdminOrganizationSchema = z
  .object({
    provider_id: z
      .string()
      .min(1)
      .optional()
      .describe("The assignment new domains bind to. Must be one of the organization's assignments."),
    address_limit: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .nullable()
      .optional()
      .describe("Active addresses the organization may hold. null goes back to the install's default."),
    address_daily_message_limit: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .nullable()
      .optional()
      .describe("Messages one address may receive per UTC day. Mail past it is dropped and counted. null goes back to the install's default."),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "Provide at least one of provider_id, address_limit or address_daily_message_limit.",
  });

export const suspendOrganizationSchema = z.object({
  reason: z.string().trim().min(1).max(500).describe("One sentence shown to the organization and on refused sends."),
});

// --- Operators and memberships (#392) ---

export const createAdminOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(100).describe("Display name for the organization."),
  slug: z
    .string()
    .trim()
    .max(100)
    .regex(/^[a-z0-9-]*$/)
    .optional()
    .describe("URL slug: lowercase letters, numbers and hyphens. Derived from the name when left out."),
});

export const listAdminUsersSchema = z.object({
  limit: LIMIT.describe("How many accounts to return, at most 200."),
  cursor: z.string().optional().describe("Id of the last account on the previous page."),
  admin: z
    .enum(["true", "false"])
    .optional()
    .describe("true for service admins only, false for the accounts without the flag. Omit for both."),
  email: z.string().trim().min(1).max(320).optional().describe("Exact email address to look up."),
  ...shapeQuery(accountShape),
});

export const patchAdminUserSchema = z.object({
  admin: z
    .boolean()
    .describe("The service-wide admin flag. Revoking it revokes the admin keys this account created, and the last admin can't be demoted."),
});

export const listMembershipsSchema = z.object({
  limit: LIMIT.describe("How many members to return, at most 200."),
  cursor: z.string().optional().describe("User id of the last member on the previous page."),
  ...shapeQuery(memberShape),
});

export const patchMembershipSchema = z.object({
  role: z.enum(ORG_ROLES).describe("The member's role in this organization. The last owner can't be demoted."),
});

/** Parses a body or query, mapping a zod failure to `validation_failed`. */
export function parseAdmin<Schema extends z.ZodType>(schema: Schema, input: unknown): z.output<Schema> {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) throw validationError(error, input);
    throw error;
  }
}
