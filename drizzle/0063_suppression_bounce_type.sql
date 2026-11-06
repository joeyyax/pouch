ALTER TABLE "suppressions" ADD COLUMN "bounce_type" text;--> statement-breakpoint
CREATE INDEX "suppressions_organization_created_idx" ON "suppressions" USING btree ("organization_id","created_at");--> statement-breakpoint
-- Rows from before this column read the bounce type off the event that suppressed them, where it survives.
UPDATE "suppressions" AS s
SET "bounce_type" = e."bounce_type"
FROM (
  SELECT DISTINCT ON ("message_id") "message_id", "bounce_type"
  FROM "message_events"
  WHERE "kind" = 'transition' AND "status" = 'bounced' AND "bounce_type" IS NOT NULL
  ORDER BY "message_id", "occurred_at" DESC
) AS e
WHERE s."source_message_id" = e."message_id" AND s."reason" = 'hard_bounce' AND s."bounce_type" IS NULL;
