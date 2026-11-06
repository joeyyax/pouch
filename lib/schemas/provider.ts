import { z } from "zod";
import { shapeQuery } from "@/lib/api/shape";
import { providerShape } from "./shapes";
import { ADAPTER_KEYS } from "@/lib/providers/adapters";

const CREDENTIALS = z
  .record(z.string(), z.string())
  .describe("Adapter-specific credentials. Validated against the adapter's own schema, checked live before it's stored.");

const SETTINGS = z
  .record(z.string(), z.string())
  .describe("Adapter-specific non-secret config, such as a webhook public key.");

/** Admin writes only. Organization routes are read-only. */
export const createProviderSchema = z.object({
  adapter: z
    .string()
    .refine((value) => (ADAPTER_KEYS as string[]).includes(value), `Provide a known provider adapter: ${ADAPTER_KEYS.join(", ")}.`)
    .describe("Provider adapter: ses, mailpace, cloudflare or mock."),
  name: z.string().trim().min(1).max(200).describe("Label for this provider, unique in the organization."),
  credentials: CREDENTIALS,
  settings: SETTINGS.optional(),
  concurrency: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(16)
    .describe("Concurrent sends allowed against this provider."),
});

export const patchProviderSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional().describe("New label for this provider."),
    settings: SETTINGS.optional(),
    concurrency: z.coerce.number().int().min(1).max(1000).optional().describe("Concurrent sends allowed against this provider."),
    credentials: CREDENTIALS.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Provide at least one field to change.");

export type PatchProviderRequest = z.output<typeof patchProviderSchema>;

export const listProvidersSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50).describe("How many providers to return, at most 200."),
  cursor: z.string().optional().describe("Id of the last provider on the previous page."),
  ...shapeQuery(providerShape),
});
