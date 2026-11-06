ALTER TABLE "provider_accounts" ADD COLUMN "shared" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD COLUMN "onboard_new" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD COLUMN "shared_account_id" text;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_shared_account_fk" FOREIGN KEY ("shared_account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_accounts_tenant_idx" ON "provider_accounts" USING btree ("organization_id","shared_account_id") WHERE "provider_accounts"."shared_account_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_accounts_onboard_new_idx" ON "provider_accounts" USING btree ("onboard_new") WHERE "provider_accounts"."onboard_new";--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_shared_check" CHECK (not ("provider_accounts"."shared" and "provider_accounts"."shared_account_id" is not null));--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_onboard_new_check" CHECK ("provider_accounts"."shared" or not "provider_accounts"."onboard_new");