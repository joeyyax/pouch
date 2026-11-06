ALTER TABLE "providers" ALTER COLUMN "concurrency" SET DEFAULT 16;--> statement-breakpoint
-- Rows still on the old default. The send-rate limiter holds each to the provider's own rate.
UPDATE "providers" SET "concurrency" = 16 WHERE "concurrency" = 4;
