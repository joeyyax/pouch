ALTER TABLE "domains" ADD COLUMN "pending_provider_account_id" text;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "pending_provider_domain_id" text;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "pending_dns_records" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "pending_missing_records" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "pending_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "pending_last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_pending_provider_account_fk" FOREIGN KEY ("organization_id","pending_provider_account_id") REFERENCES "public"."provider_accounts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "domains_pending_provider_account_idx" ON "domains" USING btree ("pending_provider_account_id");