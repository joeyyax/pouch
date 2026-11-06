import { z } from "zod";
import { shapeQuery } from "@/lib/api/shape";
import { listMemberShape, listShape } from "./shapes";
import { MEMBERSHIP_STATUSES } from "@/lib/db/schema/lists";

export const createListSchema = z.object({
  domain_id: z.string().min(1).describe("Domain this list belongs to."),
  name: z.string().min(1).max(200).describe("List name, unique per domain."),
  double_opt_in: z.boolean().optional().describe("Whether a new membership must confirm before it can receive a batch. Default true."),
});
export type CreateListRequest = z.output<typeof createListSchema>;

export const updateListSchema = z
  .object({
    name: z.string().min(1).max(200).optional().describe("List name, unique per domain."),
    double_opt_in: z
      .boolean()
      .optional()
      .describe("Whether a new membership must confirm before it can receive a batch. Memberships already on the list keep the mode they were added under."),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "Provide at least one of name or double_opt_in.",
  });
export type UpdateListRequest = z.output<typeof updateListSchema>;

export const listListsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50).describe("How many lists to return, at most 200."),
  cursor: z.string().optional().describe("Id of the last list on the previous page."),
  domain: z.string().optional().describe("Only lists on this domain."),
  ...shapeQuery(listShape),
});

const attributesSchema = z.record(z.string(), z.string()).default({}).describe("Flat attribute map substituted into {{name}} placeholders on a batch send.");

export const addMemberSchema = z.object({
  address: z.string().min(3).describe("Address to add."),
  attributes: attributesSchema.optional(),
  source: z.enum(["import", "manual"]).default("manual").describe("Where this member came from. api is reserved for subscribe on a send."),
  confirmed: z.boolean().optional().describe("Import only: marks the membership confirmed by the importer, skipping double opt-in."),
});
export type AddMemberRequest = z.output<typeof addMemberSchema>;

export const updateMemberSchema = z.object({
  attributes: z
    .record(z.string(), z.string())
    .describe("Replaces the member's attribute map outright. An empty object clears it."),
});
export type UpdateMemberRequest = z.output<typeof updateMemberSchema>;

export const importMembersSchema = z.object({
  members: z.array(addMemberSchema.omit({ source: true })).min(1).max(5000).describe("Addresses to import, at most 5000 per call."),
  confirmed: z.boolean().optional().describe("Marks every imported membership confirmed by the importer, skipping double opt-in."),
});
export type ImportMembersRequest = z.output<typeof importMembersSchema>;

export const listMembersSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50).describe("How many members to return, at most 200."),
  cursor: z.string().optional().describe("Id of the last member on the previous page."),
  status: z.enum(MEMBERSHIP_STATUSES).optional().describe("Only members with this status."),
  ...shapeQuery(listMemberShape),
});

export const unsubscribeAddressSchema = z.object({
  address: z.string().min(3).describe("Address to unsubscribe."),
});
export type UnsubscribeAddressRequest = z.output<typeof unsubscribeAddressSchema>;
