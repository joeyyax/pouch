-- provider_accounts becomes providers (#375). Renames only: no row keeps a different value
-- afterwards, and every id stays as it is. Renaming the indexes and constraints rather than
-- recreating them leaves the messages indexes and the composite keys untouched on disk.
ALTER TABLE "provider_accounts" RENAME TO "providers";--> statement-breakpoint
ALTER TABLE "providers" RENAME COLUMN "shared_account_id" TO "shared_provider_id";--> statement-breakpoint
ALTER TABLE "organizations" RENAME COLUMN "provider_account_id" TO "provider_id";--> statement-breakpoint
ALTER TABLE "domains" RENAME COLUMN "provider_account_id" TO "provider_id";--> statement-breakpoint
ALTER TABLE "domains" RENAME COLUMN "pending_provider_account_id" TO "pending_provider_id";--> statement-breakpoint
ALTER TABLE "messages" RENAME COLUMN "provider_account_id" TO "provider_id";--> statement-breakpoint
ALTER TABLE "message_events" RENAME COLUMN "provider_account_id" TO "provider_id";--> statement-breakpoint
ALTER TABLE "provider_findings" RENAME COLUMN "provider_account_id" TO "provider_id";--> statement-breakpoint
ALTER TABLE "dns_provider_records" RENAME COLUMN "provider_account_id" TO "provider_id";--> statement-breakpoint

ALTER INDEX "provider_accounts_organization_idx" RENAME TO "providers_organization_idx";--> statement-breakpoint
ALTER INDEX "provider_accounts_name_idx" RENAME TO "providers_name_idx";--> statement-breakpoint
ALTER INDEX "provider_accounts_shared_name_idx" RENAME TO "providers_shared_name_idx";--> statement-breakpoint
ALTER INDEX "provider_accounts_identity_idx" RENAME TO "providers_identity_idx";--> statement-breakpoint
ALTER INDEX "provider_accounts_tenant_idx" RENAME TO "providers_tenant_idx";--> statement-breakpoint
ALTER INDEX "provider_accounts_onboard_new_idx" RENAME TO "providers_onboard_new_idx";--> statement-breakpoint
ALTER INDEX "domains_provider_account_idx" RENAME TO "domains_provider_idx";--> statement-breakpoint
ALTER INDEX "domains_pending_provider_account_idx" RENAME TO "domains_pending_provider_idx";--> statement-breakpoint
ALTER INDEX "dns_provider_records_provider_account_idx" RENAME TO "dns_provider_records_provider_idx";--> statement-breakpoint

ALTER TABLE "providers" RENAME CONSTRAINT "provider_accounts_pkey" TO "providers_pkey";--> statement-breakpoint
ALTER TABLE "providers" RENAME CONSTRAINT "provider_accounts_org_id_key" TO "providers_org_id_key";--> statement-breakpoint
ALTER TABLE "providers" RENAME CONSTRAINT "provider_accounts_organization_id_organizations_id_fk" TO "providers_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "providers" RENAME CONSTRAINT "provider_accounts_shared_account_fk" TO "providers_shared_provider_fk";--> statement-breakpoint
ALTER TABLE "providers" RENAME CONSTRAINT "provider_accounts_shared_check" TO "providers_shared_check";--> statement-breakpoint
ALTER TABLE "providers" RENAME CONSTRAINT "provider_accounts_organization_check" TO "providers_organization_check";--> statement-breakpoint
ALTER TABLE "providers" RENAME CONSTRAINT "provider_accounts_onboard_new_check" TO "providers_onboard_new_check";--> statement-breakpoint
ALTER TABLE "organizations" RENAME CONSTRAINT "organizations_provider_account_fk" TO "organizations_provider_fk";--> statement-breakpoint
ALTER TABLE "domains" RENAME CONSTRAINT "domains_provider_account_fk" TO "domains_provider_fk";--> statement-breakpoint
ALTER TABLE "domains" RENAME CONSTRAINT "domains_pending_provider_account_fk" TO "domains_pending_provider_fk";--> statement-breakpoint
ALTER TABLE "messages" RENAME CONSTRAINT "messages_provider_account_fk" TO "messages_provider_fk";--> statement-breakpoint
ALTER TABLE "message_events" RENAME CONSTRAINT "message_events_provider_account_fk" TO "message_events_provider_fk";--> statement-breakpoint
ALTER TABLE "message_events" RENAME CONSTRAINT "message_events_provider_event_account_check" TO "message_events_provider_event_provider_check";--> statement-breakpoint
ALTER TABLE "provider_findings" RENAME CONSTRAINT "provider_findings_provider_account_id_provider_accounts_id_fk" TO "provider_findings_provider_id_providers_id_fk";--> statement-breakpoint
ALTER TABLE "provider_findings" RENAME CONSTRAINT "provider_findings_provider_account_id_type_pk" TO "provider_findings_provider_id_type_pk";--> statement-breakpoint
ALTER TABLE "dns_provider_records" RENAME CONSTRAINT "dns_provider_records_provider_account_id_provider_accounts_id_fk" TO "dns_provider_records_provider_id_providers_id_fk";
--> statement-breakpoint

-- Three activity actions lost the word tenant with it. The log is append-only, so the rows are
-- rewritten here rather than left naming actions the taxonomy no longer has.
UPDATE "activity" SET "action" = 'provider.shared.attached' WHERE "action" = 'provider.tenant.attached';--> statement-breakpoint
UPDATE "activity" SET "action" = 'provider.shared.converted' WHERE "action" = 'provider.tenant.converted';--> statement-breakpoint
UPDATE "activity" SET "action" = 'provider.shared.detached' WHERE "action" = 'provider.tenant.detached';
