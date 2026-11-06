ALTER TABLE "domains" ADD COLUMN "stalled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "stall_reason" text;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "stall_detail" jsonb;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "stall_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_stall_reason_check" CHECK ("domains"."stall_reason" is null or "domains"."stall_reason" in ('bounce_rate', 'bounce_trend', 'bounce_count', 'complaint_rate', 'complaint_trend', 'complaint_count'));