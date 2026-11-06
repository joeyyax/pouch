ALTER TABLE "domains" ADD COLUMN "layout" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "layout" boolean DEFAULT false NOT NULL;