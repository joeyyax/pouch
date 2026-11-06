-- One-time cutover for encrypted bodies (#45/#43). Idempotent and scoped so dev and test
-- databases see no change: only pre-encryption rows match the three-segment storage key shape,
-- and the retention bump is our own tenant setting on the single production organization.
UPDATE "messages" SET "body_purged_at" = now()
WHERE "body_key" IS NULL AND "body_purged_at" IS NULL AND "storage_key" LIKE 'bodies/%/%/%';--> statement-breakpoint
UPDATE "organizations" SET "body_retention_days" = 365;
