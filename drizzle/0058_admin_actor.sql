ALTER TABLE "activity" DROP CONSTRAINT "activity_actor_type_check";--> statement-breakpoint
ALTER TABLE "exports" DROP CONSTRAINT "exports_actor_type_check";--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_actor_type_check" CHECK ("activity"."actor_type" in ('user', 'admin', 'api_key', 'worker', 'provider'));--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_actor_type_check" CHECK ("exports"."actor_type" in ('user', 'admin', 'api_key', 'worker', 'provider'));