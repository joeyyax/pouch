CREATE TABLE "inbound_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"provider_message_id" text,
	"from_address" text NOT NULL,
	"from_name" text,
	"to" text[] NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"text" text,
	"html" text,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"message_id" text,
	"in_reply_to" text,
	"outbound_message_id" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_event_type_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "webhook_endpoints_events_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ALTER COLUMN "api_key_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "inbound_retention_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "inbound_provider_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "inbound_provider_id" text;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "domain_id" text;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_outbound_message_id_messages_id_fk" FOREIGN KEY ("outbound_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbound_messages_organization_domain_idx" ON "inbound_messages" USING btree ("organization_id","domain_id","received_at");--> statement-breakpoint
CREATE INDEX "inbound_messages_expires_idx" ON "inbound_messages" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "inbound_messages_in_reply_to_idx" ON "inbound_messages" USING btree ("organization_id","in_reply_to");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_messages_provider_message_idx" ON "inbound_messages" USING btree ("domain_id","provider_message_id") WHERE "inbound_messages"."provider_message_id" is not null;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_endpoints_domain_unique_idx" ON "webhook_endpoints" USING btree ("domain_id") WHERE "webhook_endpoints"."domain_id" is not null;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_inbound_retention_days_check" CHECK ("domains"."inbound_retention_days" between 1 and 30);--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_type_check" CHECK ("webhook_deliveries"."event_type" in ('email.delivered', 'email.bounced', 'email.complained', 'inbound.received'));--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_owner_check" CHECK (("webhook_endpoints"."api_key_id" is null) <> ("webhook_endpoints"."domain_id" is null));--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_events_check" CHECK ("webhook_endpoints"."events" <@ array['email.delivered', 'email.bounced', 'email.complained', 'inbound.received']::text[]);