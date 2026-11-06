ALTER TABLE "organizations" ADD COLUMN "body_retention_days" integer DEFAULT 45 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "body_key" text;