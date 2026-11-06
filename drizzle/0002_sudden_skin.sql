ALTER TABLE "domains" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "message_events" ADD COLUMN "provider_event_id" text;--> statement-breakpoint
CREATE INDEX "messages_provider_message_idx" ON "messages" USING btree ("organization_id","provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_events_provider_event_idx" ON "message_events" USING btree ("organization_id","provider_event_id") WHERE "message_events"."provider_event_id" is not null;