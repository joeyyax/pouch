DROP INDEX "messages_provider_message_idx";--> statement-breakpoint
DROP INDEX "message_events_provider_event_idx";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "provider_account_id" text;--> statement-breakpoint
ALTER TABLE "message_events" ADD COLUMN "provider_account_id" text;--> statement-breakpoint
UPDATE "messages" SET "provider_account_id" = "domains"."provider_account_id" FROM "domains" WHERE "domains"."id" = "messages"."domain_id" AND "messages"."provider_message_id" IS NOT NULL;--> statement-breakpoint
UPDATE "message_events" SET "provider_account_id" = "domains"."provider_account_id" FROM "messages", "domains" WHERE "messages"."id" = "message_events"."message_id" AND "domains"."id" = "messages"."domain_id" AND "message_events"."provider_event_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_provider_account_fk" FOREIGN KEY ("organization_id","provider_account_id") REFERENCES "public"."provider_accounts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_provider_account_fk" FOREIGN KEY ("organization_id","provider_account_id") REFERENCES "public"."provider_accounts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_provider_message_idx" ON "messages" USING btree ("organization_id","provider_account_id","provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_events_provider_event_idx" ON "message_events" USING btree ("provider_account_id","provider_event_id") WHERE "message_events"."provider_event_id" is not null;--> statement-breakpoint
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_provider_event_account_check" CHECK ("message_events"."provider_event_id" is null or "message_events"."provider_account_id" is not null);
