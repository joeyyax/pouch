import { z } from "zod";
import { shapeQuery } from "@/lib/api/shape";
import { webhookDeliveryShape, webhookEndpointShape } from "./shapes";
import { KEY_WEBHOOK_EVENT_TYPES } from "@/lib/db/schema";
import { brand } from "@/lib/brand";

const url = z.string().trim().min(1, "give it a URL");
const events = z.array(z.enum(KEY_WEBHOOK_EVENT_TYPES)).min(1, "pick at least one event");
const description = z.string().trim().max(200);

export const createWebhookEndpointSchema = z.object({
  key_id: z.string().min(1).describe("Key whose sends produce this endpoint's events."),
  url: url.describe(`https URL ${brand.name} posts to. A private or unroutable address is refused.`),
  events: events.describe(`Events to receive: ${KEY_WEBHOOK_EVENT_TYPES.join(", ")}.`),
  description: description.optional().describe("Note for whoever reads the endpoint list later."),
});
export type CreateWebhookEndpointRequest = z.output<typeof createWebhookEndpointSchema>;

export const updateWebhookEndpointSchema = z
  .object({
    url: url.optional().describe(`https URL ${brand.name} posts to. A private or unroutable address is refused.`),
    events: events.optional().describe(`Events to receive: ${KEY_WEBHOOK_EVENT_TYPES.join(", ")}.`),
    description: description.nullable().optional().describe("Note for whoever reads the endpoint list later. null clears it."),
    disabled: z.boolean().optional().describe("true stops delivery to this endpoint; false resumes it."),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "Provide at least one of url, events, description or disabled.",
  });
export type UpdateWebhookEndpointRequest = z.output<typeof updateWebhookEndpointSchema>;

export const listWebhookEndpointsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50).describe("How many endpoints to return, at most 200."),
  cursor: z.string().optional().describe("Id of the last endpoint on the previous page."),
  key_id: z.string().optional().describe("Only endpoints registered for this key."),
  ...shapeQuery(webhookEndpointShape),
});

export const listWebhookDeliveriesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50).describe("How many deliveries to return, at most 200."),
  cursor: z.string().optional().describe("Id of the last delivery on the previous page."),
  ...shapeQuery(webhookDeliveryShape),
});
