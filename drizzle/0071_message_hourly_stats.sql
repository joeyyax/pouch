CREATE TABLE "message_hourly_stats" (
	"organization_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"api_key_id" text,
	"test_mode" boolean NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"total" integer NOT NULL,
	"queued" integer NOT NULL,
	"sent" integer NOT NULL,
	"deferred" integer NOT NULL,
	"delivered" integer NOT NULL,
	"bounced" integer NOT NULL,
	"complained" integer NOT NULL,
	"failed" integer NOT NULL,
	"abandoned" integer NOT NULL,
	"handed_over" integer NOT NULL,
	"attempts" integer NOT NULL,
	"last_sent_at" timestamp with time zone,
	"queue_latency" jsonb,
	"provider_latency" jsonb,
	"end_to_end_latency" jsonb,
	"reasons" jsonb NOT NULL,
	CONSTRAINT "message_hourly_stats_cell_key" UNIQUE NULLS NOT DISTINCT("organization_id","hour","domain_id","api_key_id","test_mode")
);
--> statement-breakpoint
CREATE TABLE "message_stats_rollup" (
	"id" text PRIMARY KEY DEFAULT 'rollup' NOT NULL,
	"covered_from" timestamp with time zone NOT NULL,
	"covered_until" timestamp with time zone NOT NULL,
	"ran_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_hourly_stats" ADD CONSTRAINT "message_hourly_stats_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_hourly_stats" ADD CONSTRAINT "message_hourly_stats_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_hourly_stats_hour_idx" ON "message_hourly_stats" USING btree ("hour");--> statement-breakpoint
CREATE INDEX "messages_updated_at_idx" ON "messages" USING btree ("updated_at");