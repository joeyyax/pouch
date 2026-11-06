import { z } from "zod";
import { shapeQuery } from "@/lib/api/shape";
import { domainShape } from "./shapes";
import { DOMAIN_STATUSES } from "@/lib/db/schema/domains";
import { layoutPatchSchema } from "@/lib/domains/layout";

/** A registrable hostname: labels of letters, digits and dashes, at least two of them. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export const createDomainSchema = z.object({
  name: z
    .string()
    .min(3)
    .max(253)
    .transform((value) => value.trim().toLowerCase())
    .refine((value) => HOSTNAME.test(value), "Provide a domain name, such as example.com.")
    .describe("The domain to send from, such as example.com."),
  provider_id: z
    .string()
    .min(1)
    .optional()
    .describe("Provider this domain sends through. Defaults to the organization's assigned provider."),
});

export type CreateDomainRequest = z.output<typeof createDomainSchema>;

/** Admin-only: takes over an identity the provider already holds, for one organization. */
export const adoptDomainSchema = createDomainSchema.extend({
  organization_id: z.string().min(1).describe("The organization the adopted domain belongs to."),
});

export type AdoptDomainRequest = z.output<typeof adoptDomainSchema>;

export const patchDomainSchema = z
  .object({
    provider_id: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe("Provider to move this domain to. Records a pending binding; null cancels one in progress."),
    bulk_allowed: z
      .boolean()
      .optional()
      .describe(
        "Whether this domain may send bulk batches (POST /v1/batches). Off by default on every domain. Turning it on is refused when the domain's provider has no bulk API.",
      ),
    layout: layoutPatchSchema.optional(),
  })
  .refine((value) => value.provider_id !== undefined || value.bulk_allowed !== undefined || value.layout !== undefined, {
    message: "Provide provider_id, bulk_allowed or layout.",
  });

export const listDomainsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50).describe("How many domains to return, at most 200."),
  cursor: z.string().optional().describe("Id of the last domain on the previous page."),
  status: z.enum(DOMAIN_STATUSES).optional().describe("Only domains with this status."),
  ...shapeQuery(domainShape),
});
