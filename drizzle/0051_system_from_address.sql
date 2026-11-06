ALTER TABLE "service_settings" ADD COLUMN "system_from_address" text;--> statement-breakpoint
-- The pointer becomes the address it was already sending as. 'support' is lib/brand.ts's local part.
UPDATE "service_settings" AS s
SET "system_from_address" = 'support@' || d."name"
FROM "domains" AS d
WHERE d."id" = s."system_mail_domain_id";--> statement-breakpoint
ALTER TABLE "service_settings" DROP COLUMN "system_mail_domain_id";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "from_address";
