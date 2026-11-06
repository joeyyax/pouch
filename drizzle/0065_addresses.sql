CREATE TABLE "addresses" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"api_key_id" text,
	"local_part" text NOT NULL,
	"label" text,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"message_cap" integer,
	"received_count" integer DEFAULT 0 NOT NULL,
	"dropped_expired_count" integer DEFAULT 0 NOT NULL,
	"dropped_over_limit_count" integer DEFAULT 0 NOT NULL,
	"dropped_virus_count" integer DEFAULT 0 NOT NULL,
	"received_today" integer DEFAULT 0 NOT NULL,
	"received_day" date,
	"last_received_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "addresses_status_check" CHECK ("addresses"."status" in ('active', 'expired', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_event_type_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "webhook_endpoints_events_check";--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "address_ids" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "address_limit" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "address_daily_message_limit" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "addresses_domain_local_part_idx" ON "addresses" USING btree ("domain_id","local_part");--> statement-breakpoint
CREATE INDEX "addresses_organization_idx" ON "addresses" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "addresses_status_expires_idx" ON "addresses" USING btree ("status","expires_at");--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_type_check" CHECK ("webhook_deliveries"."event_type" in ('email.delivered', 'email.bounced', 'email.complained', 'email.unsubscribed', 'list.subscribed', 'inbound.received', 'address.received', 'domain.reputation_changed', 'organization.reputation_changed'));--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_events_check" CHECK ("webhook_endpoints"."events" <@ array['email.delivered', 'email.bounced', 'email.complained', 'email.unsubscribed', 'list.subscribed', 'inbound.received', 'address.received', 'domain.reputation_changed', 'organization.reputation_changed']::text[]);