CREATE TABLE "observation_mutes" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"tag" text,
	"api_key_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observation_mutes_one_subject_check" CHECK ("observation_mutes"."tag" is null or "observation_mutes"."api_key_id" is null)
);
--> statement-breakpoint
ALTER TABLE "observation_mutes" ADD CONSTRAINT "observation_mutes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_mutes" ADD CONSTRAINT "observation_mutes_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_mutes" ADD CONSTRAINT "observation_mutes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "observation_mutes_organization_idx" ON "observation_mutes" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "observation_mutes_tag_idx" ON "observation_mutes" USING btree ("organization_id","key","tag") WHERE "observation_mutes"."tag" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "observation_mutes_key_idx" ON "observation_mutes" USING btree ("organization_id","key","api_key_id") WHERE "observation_mutes"."api_key_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "observation_mutes_off_idx" ON "observation_mutes" USING btree ("organization_id","key") WHERE "observation_mutes"."tag" is null and "observation_mutes"."api_key_id" is null;--> statement-breakpoint
CREATE INDEX "messages_live_tagged_idx" ON "messages" USING btree ("organization_id","created_at") WHERE "messages"."test_mode" = false and cardinality("messages"."tags") > 0;