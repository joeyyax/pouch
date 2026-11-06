ALTER TABLE "api_keys" ADD COLUMN "scope" text DEFAULT 'organization' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "revoked_reason" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_created_by_idx" ON "api_keys" USING btree ("created_by");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_scope_check" CHECK ("api_keys"."scope" in ('organization', 'admin'));--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_revoked_reason_check" CHECK ("api_keys"."revoked_reason" is null or "api_keys"."revoked_reason" in ('creator_demoted', 'creator_deleted'));--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_admin_scope_check" CHECK ("api_keys"."scope" <> 'admin' or (cardinality("api_keys"."domain_ids") = 0 and "api_keys"."mode" = 'live'));