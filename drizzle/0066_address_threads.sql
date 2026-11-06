ALTER TABLE "inbound_messages" ADD COLUMN "thread_id" text;--> statement-breakpoint
UPDATE "inbound_messages" SET "thread_id" = 'thr_' || substring("id" from 5);--> statement-breakpoint
ALTER TABLE "inbound_messages" ALTER COLUMN "thread_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "inbound_messages_address_ids_idx" ON "inbound_messages" USING gin ("address_ids");--> statement-breakpoint
CREATE INDEX "inbound_messages_thread_idx" ON "inbound_messages" USING btree ("organization_id","thread_id");--> statement-breakpoint
CREATE INDEX "inbound_messages_message_key_idx" ON "inbound_messages" USING btree ("organization_id",lower(btrim("message_id", '<> ')));
