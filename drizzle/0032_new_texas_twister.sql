CREATE TABLE "batches" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"api_key_id" text,
	"list_id" text,
	"from_address" text NOT NULL,
	"subject" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"recipient_count" integer NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_unsubscribes" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "list_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"list_id" text NOT NULL,
	"address" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source" text NOT NULL,
	"source_message_id" text,
	"manual_actor" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"double_opt_in" boolean NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" text,
	"pending_expires_at" timestamp with time zone,
	"confirmation_sent_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "list_memberships_status_check" CHECK ("list_memberships"."status" in ('pending', 'subscribed', 'unsubscribed')),
	CONSTRAINT "list_memberships_source_check" CHECK ("list_memberships"."source" in ('api', 'import', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "lists" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"name" text NOT NULL,
	"double_opt_in" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity" DROP CONSTRAINT "activity_family_check";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_event_type_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "webhook_endpoints_events_check";--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "unsubscribe_url" text;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "confirm_url" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "batch_id" text;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_unsubscribes" ADD CONSTRAINT "domain_unsubscribes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_unsubscribes" ADD CONSTRAINT "domain_unsubscribes_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_memberships" ADD CONSTRAINT "list_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_memberships" ADD CONSTRAINT "list_memberships_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_memberships" ADD CONSTRAINT "list_memberships_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "batches_organization_created_idx" ON "batches" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "batches_domain_idx" ON "batches" USING btree ("domain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_unsubscribes_domain_address_idx" ON "domain_unsubscribes" USING btree ("domain_id","address");--> statement-breakpoint
CREATE INDEX "domain_unsubscribes_organization_idx" ON "domain_unsubscribes" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "list_memberships_list_address_idx" ON "list_memberships" USING btree ("list_id","address");--> statement-breakpoint
CREATE INDEX "list_memberships_organization_idx" ON "list_memberships" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "list_memberships_list_status_idx" ON "list_memberships" USING btree ("list_id","status");--> statement-breakpoint
CREATE INDEX "list_memberships_pending_expiry_idx" ON "list_memberships" USING btree ("status","pending_expires_at");--> statement-breakpoint
CREATE INDEX "list_memberships_confirmation_due_idx" ON "list_memberships" USING btree ("status","double_opt_in","confirmation_sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lists_domain_name_idx" ON "lists" USING btree ("domain_id","name");--> statement-breakpoint
CREATE INDEX "lists_organization_idx" ON "lists" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "messages_batch_idx" ON "messages" USING btree ("batch_id");--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_family_check" CHECK ("activity"."family" in ('key', 'domain', 'suppression', 'settings', 'webhook', 'provider', 'session', 'system', 'list'));--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_type_check" CHECK ("webhook_deliveries"."event_type" in ('email.delivered', 'email.bounced', 'email.complained', 'email.unsubscribed', 'list.subscribed', 'inbound.received'));--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_events_check" CHECK ("webhook_endpoints"."events" <@ array['email.delivered', 'email.bounced', 'email.complained', 'email.unsubscribed', 'list.subscribed', 'inbound.received']::text[]);