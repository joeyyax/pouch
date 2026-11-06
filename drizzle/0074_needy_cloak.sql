ALTER TABLE "activity" ADD COLUMN "ip_hash" text;--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "user_agent" text;--> statement-breakpoint
CREATE INDEX "activity_action_created_at_idx" ON "activity" USING btree ("action","created_at");