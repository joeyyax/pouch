ALTER TABLE "message_events" ALTER COLUMN "status" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message_events" ADD COLUMN "kind" text DEFAULT 'transition' NOT NULL;--> statement-breakpoint
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_status_kind_check" CHECK (("message_events"."kind" = 'transition') = ("message_events"."status" is not null));