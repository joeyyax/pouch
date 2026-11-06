CREATE TABLE "activity" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"action" text NOT NULL,
	"family" text NOT NULL,
	"outcome" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"actor_label" text NOT NULL,
	"applies_to" text,
	"subject_label" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_org_created_at_idx" ON "activity" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE INDEX "activity_org_family_created_at_idx" ON "activity" USING btree ("organization_id","family","created_at");--> statement-breakpoint
CREATE INDEX "activity_org_outcome_created_at_idx" ON "activity" USING btree ("organization_id","outcome","created_at");--> statement-breakpoint
CREATE INDEX "activity_org_applies_to_idx" ON "activity" USING btree ("organization_id","applies_to");--> statement-breakpoint
CREATE INDEX "activity_org_actor_idx" ON "activity" USING btree ("organization_id","actor_type","actor_id");