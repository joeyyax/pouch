ALTER TABLE "messages" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message_events" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "suppressions" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message_hourly_stats" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_service_idempotency_idx" ON "messages" USING btree ("idempotency_key") WHERE "messages"."organization_id" is null and "messages"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "messages_service_created_idx" ON "messages" USING btree ("created_at","id") WHERE "messages"."organization_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_service_address_idx" ON "suppressions" USING btree ("address") WHERE "suppressions"."organization_id" is null;--> statement-breakpoint
-- System mail: no API key, no batch, an idempotency key from one of the system senders and their tags.
CREATE TEMPORARY TABLE "service_mail" ON COMMIT DROP AS
SELECT "id", "organization_id" AS "carrier_id", "idempotency_key", "created_at", "recipients"
FROM "messages"
WHERE "api_key_id" IS NULL
  AND "batch_id" IS NULL
  AND "organization_id" IS NOT NULL
  AND "tags" && ARRAY[
    'system-alert', 'system-digest', 'password-reset', 'magic-link', 'invitation', 'forward-confirmation', 'reputation-alert',
    'account_targeted', 'tag_quiet', 'domain_spoofed', 'delivery_time', 'dmarc_policy_ready'
  ]::text[]
  AND "idempotency_key" ~ '^(password-reset|magic-link|invitation|forward-confirm|digest|bulk-fanout|domain-verification-failed|key-created|key-revoked|provider-backing-off|webhook-endpoint-disabled|reputation|standing_at_risk|standing_paused|standing_resumed|account_targeted|tag_quiet|domain_spoofed|delivery_time|dmarc_policy_ready):';--> statement-breakpoint
-- Keys were unique per organization. Moving the system from address made repeats possible; the newest keeps its key.
UPDATE "messages" SET "idempotency_key" = NULL
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (PARTITION BY "idempotency_key" ORDER BY "created_at" DESC, "id" DESC) AS "n" FROM "service_mail"
  ) AS "ranked" WHERE "n" > 1
);--> statement-breakpoint
UPDATE "messages" SET "organization_id" = NULL, "updated_at" = now() WHERE "id" IN (SELECT "id" FROM "service_mail");--> statement-breakpoint
UPDATE "message_events" SET "organization_id" = NULL WHERE "message_id" IN (SELECT "id" FROM "service_mail");--> statement-breakpoint
-- A bounce or complaint on system mail suppressed the address in the carrier's list. It moves to the service's.
DELETE FROM "suppressions" AS "s"
USING "service_mail" AS "m"
WHERE "s"."source_message_id" = "m"."id"
  AND EXISTS (
    SELECT 1 FROM "suppressions" AS "kept"
    JOIN "service_mail" AS "other" ON "other"."id" = "kept"."source_message_id"
    WHERE "kept"."address" = "s"."address" AND ("kept"."created_at", "kept"."id") < ("s"."created_at", "s"."id")
  );--> statement-breakpoint
UPDATE "suppressions" SET "organization_id" = NULL WHERE "source_message_id" IN (SELECT "id" FROM "service_mail");--> statement-breakpoint
-- Recipient history the carrier only has because of system mail.
DELETE FROM "recipient_history" AS "h"
WHERE EXISTS (
    SELECT 1 FROM "service_mail" AS "m" WHERE "m"."carrier_id" = "h"."organization_id" AND "m"."recipients" @> ARRAY["h"."address"]
  )
  AND NOT EXISTS (
    SELECT 1 FROM "messages" AS "own" WHERE "own"."organization_id" = "h"."organization_id" AND "own"."recipients" @> ARRAY["h"."address"]
  );--> statement-breakpoint
-- The carrier's cells for those hours counted system mail. The next rollup redoes just those hours.
DELETE FROM "message_hourly_stats" AS "c"
USING (SELECT DISTINCT "carrier_id", date_trunc('hour', "created_at", 'UTC') AS "hour" FROM "service_mail") AS "a"
WHERE "c"."organization_id" = "a"."carrier_id" AND "c"."hour" = "a"."hour";--> statement-breakpoint
UPDATE "messages" AS "m" SET "updated_at" = now()
FROM (SELECT DISTINCT "carrier_id", date_trunc('hour', "created_at", 'UTC') AS "hour" FROM "service_mail") AS "a"
WHERE "m"."organization_id" = "a"."carrier_id"
  AND "m"."created_at" >= "a"."hour" AND "m"."created_at" < "a"."hour" + interval '1 hour';
