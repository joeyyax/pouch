CREATE TABLE "recipient_history" (
	"organization_id" text NOT NULL,
	"address" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_delivered_at" timestamp with time zone,
	"last_bounced_at" timestamp with time zone,
	"bounce_count" integer DEFAULT 0 NOT NULL,
	"last_complained_at" timestamp with time zone,
	"complaint_count" integer DEFAULT 0 NOT NULL,
	"last_deferred_at" timestamp with time zone,
	"deferred_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipient_history_organization_id_address_pk" PRIMARY KEY("organization_id","address")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "recipient_history" ADD CONSTRAINT "recipient_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recipient_history_organization_idx" ON "recipient_history" USING btree ("organization_id");