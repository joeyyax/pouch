CREATE TABLE "dns_provider_records" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"dns_provider_account_id" text NOT NULL,
	"zone_name" text NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"written_value" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dns_provider_records" ADD CONSTRAINT "dns_provider_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_provider_records" ADD CONSTRAINT "dns_provider_records_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_provider_records" ADD CONSTRAINT "dns_provider_records_dns_provider_account_id_dns_provider_accounts_id_fk" FOREIGN KEY ("dns_provider_account_id") REFERENCES "public"."dns_provider_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dns_provider_records_domain_idx" ON "dns_provider_records" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "dns_provider_records_organization_idx" ON "dns_provider_records" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "dns_provider_records_lookup_idx" ON "dns_provider_records" USING btree ("domain_id","type","name");