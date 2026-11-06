CREATE TABLE "exports" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"actor_label" text NOT NULL,
	"filters" jsonb,
	"count" integer,
	"object_key" text,
	"content_type" text,
	"filename" text,
	"size_bytes" integer,
	"error" text,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "exports_kind_check" CHECK ("exports"."kind" in ('log_csv', 'log_ndjson', 'bodies', 'data')),
	CONSTRAINT "exports_status_check" CHECK ("exports"."status" in ('requested', 'running', 'ready', 'failed', 'expired')),
	CONSTRAINT "exports_actor_type_check" CHECK ("exports"."actor_type" in ('user', 'api_key', 'worker', 'provider'))
);
--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exports_organization_requested_idx" ON "exports" USING btree ("organization_id","requested_at");--> statement-breakpoint
CREATE INDEX "exports_claim_idx" ON "exports" USING btree ("status","requested_at");--> statement-breakpoint
CREATE INDEX "exports_expiry_idx" ON "exports" USING btree ("status","expires_at");