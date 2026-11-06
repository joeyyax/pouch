import { z } from "zod";
import { shapeQuery } from "@/lib/api/shape";
import { keyShape } from "./shapes";
import { API_KEY_MODES } from "@/lib/db/schema/api-keys";

const name = z
  .string()
  .trim()
  .min(1, "give the key a name")
  .max(64)
  .regex(/^[a-zA-Z0-9-]+$/, "use letters, digits and hyphens");

const domainIds = z.array(z.string().min(1));
const rateLimit = z.coerce.number().int().min(1).max(10_000);

export const createKeySchema = z.object({
  name: name.describe("Name for the key. Letters, digits and hyphens, unique among the organization's live keys."),
  mode: z.enum(API_KEY_MODES).default("live").describe("live sends real mail; test routes every send to the mock provider. A test key can only create test keys."),
  domain_ids: domainIds.default([]).describe("Domains this key may send from. Empty means every domain in the organization."),
  rate_limit: rateLimit.optional().describe("Requests a minute this key is allowed, 1-10000. The install's default for new keys when absent: 3000 unless an admin changed it."),
});
export type CreateKeyRequest = z.output<typeof createKeySchema>;

export const createAdminKeySchema = createKeySchema.pick({ name: true });
export type CreateAdminKeyRequest = z.output<typeof createAdminKeySchema>;

export const updateKeySchema = z
  .object({
    name: name.optional().describe("New name for the key."),
    domain_ids: domainIds.optional().describe("Domains this key may send from. Empty means every domain in the organization."),
    rate_limit: rateLimit.optional().describe("Requests a minute this key is allowed, 1-10000."),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "Provide at least one of name, domain_ids or rate_limit.",
  });
export type UpdateKeyRequest = z.output<typeof updateKeySchema>;

export const listKeysSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50).describe("How many keys to return, at most 200."),
  cursor: z.string().optional().describe("Id of the last key on the previous page."),
  mode: z.enum(API_KEY_MODES).optional().describe("Only keys in this mode."),
  revoked: z
    .enum(["true", "false"])
    .optional()
    .describe("true for revoked keys only, false for live ones only. Omit for both."),
  domain: z.string().min(1).optional().describe("A domain id. Only keys that reach it: limited to it, or to no domain."),
  ...shapeQuery(keyShape),
});
