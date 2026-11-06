ALTER TABLE "activity" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_accounts" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
-- An organization assigned straight to a shared account holds the composite foreign key the
-- nulling below would break. Its tenant rows are untouched.
UPDATE "organizations" SET "provider_account_id" = NULL
WHERE "provider_account_id" IN (SELECT "id" FROM "provider_accounts" WHERE "shared");--> statement-breakpoint
-- Shared names were unique per organization and are about to share one namespace.
WITH "clashes" AS (
  SELECT "id", "name", row_number() OVER (PARTITION BY "name" ORDER BY "created_at", "id") AS "n"
  FROM "provider_accounts"
  WHERE "shared"
)
UPDATE "provider_accounts" "pa"
SET "name" = "clashes"."name" || ' (' || "clashes"."n" || ')'
FROM "clashes"
WHERE "pa"."id" = "clashes"."id" AND "clashes"."n" > 1;--> statement-breakpoint
UPDATE "provider_accounts" SET "organization_id" = NULL WHERE "shared";--> statement-breakpoint
UPDATE "api_keys" SET "organization_id" = NULL WHERE "scope" = 'admin';--> statement-breakpoint
-- The system organization's activity is service-level activity, so it outlives the row below.
UPDATE "activity" SET "organization_id" = NULL
WHERE "organization_id" IN (SELECT "id" FROM "organizations" WHERE "slug" = 'pouch-system');--> statement-breakpoint
-- Skipped when anything still lives there: deleting an organization takes its people with it.
DELETE FROM "organizations" "o"
WHERE "o"."slug" = 'pouch-system'
  AND NOT EXISTS (SELECT 1 FROM "users" WHERE "users"."organization_id" = "o"."id")
  AND NOT EXISTS (SELECT 1 FROM "memberships" WHERE "memberships"."organization_id" = "o"."id")
  AND NOT EXISTS (SELECT 1 FROM "domains" WHERE "domains"."organization_id" = "o"."id")
  AND NOT EXISTS (SELECT 1 FROM "messages" WHERE "messages"."organization_id" = "o"."id")
  AND NOT EXISTS (SELECT 1 FROM "provider_accounts" WHERE "provider_accounts"."organization_id" = "o"."id")
  AND NOT EXISTS (SELECT 1 FROM "api_keys" WHERE "api_keys"."organization_id" = "o"."id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_accounts_shared_name_idx" ON "provider_accounts" USING btree ("name") WHERE "provider_accounts"."organization_id" is null;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_check" CHECK (("api_keys"."scope" = 'admin') = ("api_keys"."organization_id" is null));--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_organization_check" CHECK ("provider_accounts"."shared" = ("provider_accounts"."organization_id" is null));
