CREATE TABLE "provider_findings" (
	"organization_id" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"type" text NOT NULL,
	"impact" text,
	"description" text,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "provider_findings_provider_account_id_type_pk" PRIMARY KEY("provider_account_id","type")
);
--> statement-breakpoint
CREATE TABLE "reputation_states" (
	"organization_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"standing" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"alerted_standing" text,
	"alerted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reputation_states_subject_type_subject_id_pk" PRIMARY KEY("subject_type","subject_id"),
	CONSTRAINT "reputation_states_subject_type_check" CHECK ("reputation_states"."subject_type" in ('domain', 'organization')),
	CONSTRAINT "reputation_states_standing_check" CHECK ("reputation_states"."standing" in ('healthy', 'watch', 'at_risk', 'paused')),
	CONSTRAINT "reputation_states_alerted_standing_check" CHECK ("reputation_states"."alerted_standing" is null or "reputation_states"."alerted_standing" in ('healthy', 'watch', 'at_risk', 'paused'))
);
--> statement-breakpoint
CREATE TABLE "suppressed_rejections" (
	"organization_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "suppressed_rejections_domain_id_hour_pk" PRIMARY KEY("domain_id","hour")
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_event_type_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "webhook_endpoints_events_check";--> statement-breakpoint
ALTER TABLE "provider_findings" ADD CONSTRAINT "provider_findings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_findings" ADD CONSTRAINT "provider_findings_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_states" ADD CONSTRAINT "reputation_states_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressed_rejections" ADD CONSTRAINT "suppressed_rejections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressed_rejections" ADD CONSTRAINT "suppressed_rejections_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_findings_organization_idx" ON "provider_findings" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "reputation_states_organization_idx" ON "reputation_states" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "suppressed_rejections_organization_hour_idx" ON "suppressed_rejections" USING btree ("organization_id","hour");--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_type_check" CHECK ("webhook_deliveries"."event_type" in ('email.delivered', 'email.bounced', 'email.complained', 'email.unsubscribed', 'list.subscribed', 'inbound.received', 'domain.reputation_changed', 'organization.reputation_changed'));--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_events_check" CHECK ("webhook_endpoints"."events" <@ array['email.delivered', 'email.bounced', 'email.complained', 'email.unsubscribed', 'list.subscribed', 'inbound.received', 'domain.reputation_changed', 'organization.reputation_changed']::text[]);