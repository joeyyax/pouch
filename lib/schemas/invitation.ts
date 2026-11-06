import { z } from "zod";
import { shapeQuery } from "@/lib/api/shape";
import { invitationShape } from "./shapes";
import { ORG_ROLES } from "@/lib/auth/permissions";

export const createInvitationSchema = z.object({
  email: z.string().trim().min(3).max(320).describe("Address to invite. One live invitation per address per organization."),
  role: z
    .enum(ORG_ROLES)
    .default("member")
    .describe("Role the invited person gets in this organization. Service-wide admin is granted separately, after they join."),
});

export const listInvitationsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50).describe("How many invitations to return, at most 200."),
  cursor: z.string().optional().describe("Id of the last invitation on the previous page."),
  status: z
    .enum(["pending", "accepted", "revoked", "expired"])
    .optional()
    .describe("Only invitations in this state. pending excludes expired ones; expired is a pending invitation past its expiry."),
  ...shapeQuery(invitationShape),
});
