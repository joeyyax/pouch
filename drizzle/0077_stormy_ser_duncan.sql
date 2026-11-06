ALTER TABLE "messages" ADD COLUMN "body_withheld" text;--> statement-breakpoint
UPDATE "messages" SET "body_withheld" = CASE
    WHEN "tags" @> ARRAY['password-reset'] THEN 'a password reset link'
    WHEN "tags" @> ARRAY['magic-link'] THEN 'a sign-in link'
    WHEN "tags" @> ARRAY['invitation'] THEN 'an invitation link'
    ELSE 'a forwarding confirmation link'
  END
WHERE "api_key_id" IS NULL
  AND (
    ("tags" @> ARRAY['password-reset'] AND "idempotency_key" LIKE 'password-reset:%')
    OR ("tags" @> ARRAY['magic-link'] AND "idempotency_key" LIKE 'magic-link:%')
    OR ("tags" @> ARRAY['invitation'] AND "idempotency_key" LIKE 'invitation:%')
    OR ("tags" @> ARRAY['forward-confirmation'] AND "idempotency_key" LIKE 'forward-confirm:%')
  );--> statement-breakpoint
UPDATE "messages" SET "body_key" = NULL, "body_purged_at" = coalesce("body_purged_at", now())
WHERE "body_withheld" IS NOT NULL AND "body_key" IS NOT NULL AND "status" <> 'queued';
