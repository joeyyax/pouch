CREATE TABLE "bulk_fanout_recipients" (
	"organization_id" text NOT NULL,
	"api_key_id" text NOT NULL,
	"body_hash" text NOT NULL,
	"day" date NOT NULL,
	"recipient_hash" text NOT NULL,
	CONSTRAINT "bulk_fanout_recipients_api_key_id_body_hash_day_recipient_hash_pk" PRIMARY KEY("api_key_id","body_hash","day","recipient_hash")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "body_hash" text;--> statement-breakpoint
ALTER TABLE "bulk_fanout_recipients" ADD CONSTRAINT "bulk_fanout_recipients_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_fanout_recipients" ADD CONSTRAINT "bulk_fanout_recipients_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bulk_fanout_recipients_organization_idx" ON "bulk_fanout_recipients" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "messages_api_key_body_hash_idx" ON "messages" USING btree ("api_key_id","body_hash");