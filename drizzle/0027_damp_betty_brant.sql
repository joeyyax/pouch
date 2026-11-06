CREATE TABLE "dns_provider_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"module" text NOT NULL,
	"name" text NOT NULL,
	"credentials" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dns_provider_accounts_org_id_key" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "dns_provider_accounts" ADD CONSTRAINT "dns_provider_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dns_provider_accounts_organization_idx" ON "dns_provider_accounts" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dns_provider_accounts_name_idx" ON "dns_provider_accounts" USING btree ("organization_id","name");