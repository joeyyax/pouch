ALTER TABLE "domains" ADD COLUMN "inbound_subdomain" text DEFAULT 'inbound' NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "raw_storage_key" text;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "verdicts" jsonb;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_inbound_subdomain_check" CHECK ("domains"."inbound_subdomain" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$');