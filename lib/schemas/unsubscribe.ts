import { z } from "zod";

export const confirmSchema = z.object({
  token: z.string().min(1).describe("Confirmation token from the email link."),
});

export const unsubscribeRedeemSchema = z.object({
  token: z.string().min(1).describe("Unsubscribe token from the List-Unsubscribe link or the branded page."),
  scope: z.enum(["list", "domain"]).default("list").describe("Unsubscribe from just this list, or every list on the domain."),
});
