CREATE TABLE "domain_daily_stats" (
	"organization_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"day" date NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"delivery_window_start" timestamp with time zone NOT NULL,
	"delivered_count" integer NOT NULL,
	"delivery_min_ms" integer,
	"delivery_p10_ms" integer,
	"delivery_p25_ms" integer,
	"delivery_p50_ms" integer,
	"delivery_p75_ms" integer,
	"delivery_p90_ms" integer,
	"delivery_p99_ms" integer,
	"delivery_max_ms" integer,
	"volume_window_start" timestamp with time zone NOT NULL,
	"hourly_volume" integer[] NOT NULL,
	CONSTRAINT "domain_daily_stats_domain_id_day_pk" PRIMARY KEY("domain_id","day")
);
--> statement-breakpoint
ALTER TABLE "domain_daily_stats" ADD CONSTRAINT "domain_daily_stats_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_daily_stats" ADD CONSTRAINT "domain_daily_stats_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "domain_daily_stats_organization_idx" ON "domain_daily_stats" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "domain_daily_stats_day_idx" ON "domain_daily_stats" USING btree ("day");