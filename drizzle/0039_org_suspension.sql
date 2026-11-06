ALTER TABLE "organizations" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "suspend_reason" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "suspend_source" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "suspend_detail" jsonb;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "suspension_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_suspend_source_check" CHECK ("organizations"."suspend_source" is null or "organizations"."suspend_source" in ('manual', 'reputation', 'provider'));