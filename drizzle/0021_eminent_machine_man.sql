ALTER TABLE "message_events" DROP CONSTRAINT "message_events_kind_check";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "abandoned_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "messages_status_sent_idx" ON "messages" USING btree ("status","sent_at");--> statement-breakpoint
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_kind_check" CHECK ("message_events"."kind" in ('transition', 'retry', 'backoff', 'suppressed', 'body_shredded', 'webhook_delivered', 'abandoned'));