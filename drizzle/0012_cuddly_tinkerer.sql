ALTER TABLE "api_keys" ALTER COLUMN "rate_limit" SET DEFAULT 3000;--> statement-breakpoint
-- Keys still carrying the old default move with it. A key set to anything else was set deliberately.
UPDATE "api_keys" SET "rate_limit" = 3000 WHERE "rate_limit" = 120;
