CREATE TABLE "dmarc_domain_tokens" (
	"domain_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"token" text NOT NULL,
	"policy_ready_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dmarc_report_hosts" (
	"id" text PRIMARY KEY DEFAULT 'service' NOT NULL,
	"host" text,
	"provider_id" text,
	"route" jsonb,
	"verified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dmarc_report_hosts_singleton_check" CHECK ("dmarc_report_hosts"."id" = 'service')
);
--> statement-breakpoint
CREATE TABLE "dmarc_report_records" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"report_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"source_ip" text NOT NULL,
	"count" integer NOT NULL,
	"origin" text NOT NULL,
	"disposition" text NOT NULL,
	"dkim" text NOT NULL,
	"spf" text NOT NULL,
	"header_from" text NOT NULL,
	"envelope_from" text,
	"dkim_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"spf_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "dmarc_report_records_origin_check" CHECK ("dmarc_report_records"."origin" in ('provider', 'other', 'forwarded', 'unauthenticated'))
);
--> statement-breakpoint
CREATE TABLE "dmarc_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"reporter" text NOT NULL,
	"reporter_email" text,
	"report_id" text NOT NULL,
	"begins_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"policy" jsonb NOT NULL,
	"message_count" integer NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "dmarc_reports_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "dmarc_domain_tokens" ADD CONSTRAINT "dmarc_domain_tokens_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmarc_domain_tokens" ADD CONSTRAINT "dmarc_domain_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmarc_report_hosts" ADD CONSTRAINT "dmarc_report_hosts_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmarc_report_records" ADD CONSTRAINT "dmarc_report_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmarc_report_records" ADD CONSTRAINT "dmarc_report_records_report_id_dmarc_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."dmarc_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmarc_report_records" ADD CONSTRAINT "dmarc_report_records_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmarc_reports" ADD CONSTRAINT "dmarc_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmarc_reports" ADD CONSTRAINT "dmarc_reports_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dmarc_domain_tokens_token_idx" ON "dmarc_domain_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "dmarc_report_records_report_idx" ON "dmarc_report_records" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "dmarc_report_records_domain_idx" ON "dmarc_report_records" USING btree ("organization_id","domain_id","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dmarc_reports_unique_idx" ON "dmarc_reports" USING btree ("domain_id","reporter","report_id");--> statement-breakpoint
CREATE INDEX "dmarc_reports_domain_idx" ON "dmarc_reports" USING btree ("organization_id","domain_id","ends_at");--> statement-breakpoint
CREATE INDEX "dmarc_reports_received_idx" ON "dmarc_reports" USING btree ("organization_id","received_at");