ALTER TABLE "service_settings" ADD COLUMN "default_provider_id" text;--> statement-breakpoint
ALTER TABLE "service_settings" ADD CONSTRAINT "service_settings_default_provider_fk" FOREIGN KEY ("default_provider_id") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- The flag becomes the pointer. The partial unique index guaranteed at most one row set.
INSERT INTO "service_settings" ("id", "default_provider_id")
SELECT 'service', p."id" FROM "providers" AS p WHERE p."onboard_new"
ON CONFLICT ("id") DO UPDATE SET "default_provider_id" = excluded."default_provider_id", "updated_at" = now();--> statement-breakpoint
ALTER TABLE "providers" DROP CONSTRAINT "providers_onboard_new_check";--> statement-breakpoint
DROP INDEX "providers_onboard_new_idx";--> statement-breakpoint
ALTER TABLE "providers" DROP COLUMN "onboard_new";
