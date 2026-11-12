ALTER TABLE "domains" ADD COLUMN "stall_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "stall_released_detail" jsonb;