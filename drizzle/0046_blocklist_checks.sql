CREATE TABLE "domain_blocklist_checks" (
	"organization_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"list" text NOT NULL,
	"status" text,
	"code" text,
	"reason" text,
	"checked_at" timestamp with time zone,
	"listed_since" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	CONSTRAINT "domain_blocklist_checks_domain_id_list_pk" PRIMARY KEY("domain_id","list"),
	CONSTRAINT "domain_blocklist_checks_list_check" CHECK ("domain_blocklist_checks"."list" in ('dbl', 'zrd')),
	CONSTRAINT "domain_blocklist_checks_status_check" CHECK ("domain_blocklist_checks"."status" is null or "domain_blocklist_checks"."status" in ('clear', 'listed'))
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "link_listings" jsonb;--> statement-breakpoint
ALTER TABLE "domain_blocklist_checks" ADD CONSTRAINT "domain_blocklist_checks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_blocklist_checks" ADD CONSTRAINT "domain_blocklist_checks_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "domain_blocklist_checks_organization_idx" ON "domain_blocklist_checks" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "messages_link_listings_idx" ON "messages" USING btree ("organization_id","sent_at") WHERE "messages"."link_listings" is not null;