CREATE TABLE "service_settings" (
	"id" text PRIMARY KEY DEFAULT 'service' NOT NULL,
	"system_mail_domain_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_settings_singleton_check" CHECK ("service_settings"."id" = 'service')
);
