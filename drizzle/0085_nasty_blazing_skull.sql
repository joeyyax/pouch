ALTER TABLE "domains" DROP CONSTRAINT "domains_inbound_retention_days_check";--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "address_limit" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "address_limit" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "address_daily_message_limit" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "address_daily_message_limit" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "inbound_messages_received_idx" ON "inbound_messages" USING btree ("received_at");--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_inbound_retention_days_check" CHECK ("domains"."inbound_retention_days" between 1 and 365);--> statement-breakpoint
UPDATE "organizations" SET "address_limit" = NULL WHERE "address_limit" = 500;--> statement-breakpoint
UPDATE "organizations" SET "address_daily_message_limit" = NULL WHERE "address_daily_message_limit" = 100;