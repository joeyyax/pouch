ALTER TABLE "organizations" ADD COLUMN "provider_account_id" text;--> statement-breakpoint
-- Hand-narrowed: a plain SET NULL would null "id" too.
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_provider_account_fk" FOREIGN KEY ("id","provider_account_id") REFERENCES "public"."provider_accounts"("organization_id","id") ON DELETE SET NULL ("provider_account_id") ON UPDATE no action;--> statement-breakpoint
-- Each organization's only non-shared row, or the one with the most bound domains. Ties stay null.
WITH "bound" AS (
  SELECT "pa"."organization_id", "pa"."id", count("d"."id") AS "domains"
  FROM "provider_accounts" "pa"
  LEFT JOIN "domains" "d" ON "d"."provider_account_id" = "pa"."id"
  WHERE NOT "pa"."shared"
  GROUP BY "pa"."organization_id", "pa"."id"
), "ranked" AS (
  SELECT "organization_id", "id", rank() OVER (PARTITION BY "organization_id" ORDER BY "domains" DESC) AS "place"
  FROM "bound"
), "picked" AS (
  SELECT "organization_id", min("id") AS "id"
  FROM "ranked"
  WHERE "place" = 1
  GROUP BY "organization_id"
  HAVING count(*) = 1
)
UPDATE "organizations" "o"
SET "provider_account_id" = "picked"."id"
FROM "picked"
WHERE "o"."id" = "picked"."organization_id";
