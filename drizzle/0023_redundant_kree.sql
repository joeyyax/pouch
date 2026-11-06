CREATE TABLE "memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_user_organization_unique" UNIQUE("user_id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token" text NOT NULL,
	"invited_by" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "operator" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memberships_organization_idx" ON "memberships" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invitations_organization_idx" ON "invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitations_email_idx" ON "invitations" USING btree ("email");--> statement-breakpoint
-- backfill:start
-- Before this migration, every row in `users` was implicitly a full administrator of its own
-- organization — there was no lesser role. This preserves exactly that access for every
-- existing user: an owner-level membership on their current `organization_id`. Derived from
-- the existing column, never from a seed value or an env var, and idempotent — safe to run
-- again against a database where these users and their memberships already exist.
INSERT INTO "memberships" ("id", "user_id", "organization_id", "role", "created_at")
SELECT 'mem_' || replace(gen_random_uuid()::text, '-', ''), "id", "organization_id", 'owner', now()
FROM "users"
ON CONFLICT ("user_id", "organization_id") DO NOTHING;
--> statement-breakpoint
-- The operator flag does NOT follow the same "every existing user" rule — operator is
-- service-wide, and granting it to everyone who happens to have a row today would be a
-- silent privilege escalation on any install with more than one user: before this migration
-- an admin could see their own organization only, and an upgrade is not consent to see every
-- organization. So this only ever promotes when the database has exactly one user, matching
-- the first-user bootstrap rule in lib/auth/provisioning.ts and covering every Pouch
-- deployment that exists today, including production, which has exactly one. A multi-user
-- installation gets no operator from this migration — recoverable and visible, unlike three
-- unintended ones — and must promote someone deliberately afterward: set ADMIN_EMAIL to that
-- person and run `pnpm seed`, or run `UPDATE users SET operator = true WHERE id = '<id>'`
-- directly.
UPDATE "users" SET "operator" = true
WHERE (SELECT count(*) FROM "users") = 1;
-- backfill:end