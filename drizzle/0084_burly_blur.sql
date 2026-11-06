CREATE TABLE "notification_preferences" (
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"email" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_user_id_type_pk" PRIMARY KEY("user_id","type")
);
--> statement-breakpoint
CREATE TABLE "notification_sends" (
	"organization_id" text NOT NULL,
	"type" text NOT NULL,
	"about" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"cleared_at" timestamp with time zone,
	CONSTRAINT "notification_sends_organization_id_type_about_pk" PRIMARY KEY("organization_id","type","about")
);
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_sends" ADD CONSTRAINT "notification_sends_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_sends_held_idx" ON "notification_sends" USING btree ("organization_id","type") WHERE "notification_sends"."cleared_at" is null;