CREATE TABLE "address_forward_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"address_id" text NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"token_hash" text,
	"token_expires_at" timestamp with time zone,
	"confirmation_sent_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	"forwarded_count" integer DEFAULT 0 NOT NULL,
	"last_forwarded_at" timestamp with time zone,
	"last_failure" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "address_forward_targets_status_check" CHECK ("address_forward_targets"."status" in ('pending', 'confirmed', 'disabled')),
	CONSTRAINT "address_forward_targets_disabled_reason_check" CHECK ("address_forward_targets"."disabled_reason" is null or "address_forward_targets"."disabled_reason" in ('bounced', 'complained', 'stopped'))
);
--> statement-breakpoint
CREATE TABLE "address_forwards" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"address_id" text NOT NULL,
	"target_id" text NOT NULL,
	"inbound_message_id" text NOT NULL,
	"message_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "address_forwards_status_check" CHECK ("address_forwards"."status" in ('pending', 'sent', 'failed', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN "forwarded_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "address_forward_targets" ADD CONSTRAINT "address_forward_targets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address_forward_targets" ADD CONSTRAINT "address_forward_targets_address_id_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."addresses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address_forwards" ADD CONSTRAINT "address_forwards_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address_forwards" ADD CONSTRAINT "address_forwards_address_id_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."addresses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address_forwards" ADD CONSTRAINT "address_forwards_target_id_address_forward_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."address_forward_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address_forwards" ADD CONSTRAINT "address_forwards_inbound_message_id_inbound_messages_id_fk" FOREIGN KEY ("inbound_message_id") REFERENCES "public"."inbound_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address_forwards" ADD CONSTRAINT "address_forwards_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "address_forward_targets_address_email_idx" ON "address_forward_targets" USING btree ("address_id",lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "address_forward_targets_token_idx" ON "address_forward_targets" USING btree ("token_hash") WHERE "address_forward_targets"."token_hash" is not null;--> statement-breakpoint
CREATE INDEX "address_forward_targets_organization_idx" ON "address_forward_targets" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "address_forwards_message_target_idx" ON "address_forwards" USING btree ("inbound_message_id","target_id");--> statement-breakpoint
CREATE INDEX "address_forwards_pending_idx" ON "address_forwards" USING btree ("created_at") WHERE "address_forwards"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "address_forwards_message_idx" ON "address_forwards" USING btree ("message_id");