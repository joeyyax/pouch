import { z } from "zod";
import { STREAM_EVENT_TYPES } from "@/lib/messages/stream";

export const listEventsSchema = z.object({
  type: z
    .enum(STREAM_EVENT_TYPES as [string, ...string[]])
    .optional()
    .describe("Only events of this type, matching a webhook event type — e.g. email.delivered."),
});
