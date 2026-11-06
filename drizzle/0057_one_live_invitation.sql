-- One live invitation per address per organization. Older duplicates, if any exist, are revoked first.
UPDATE "invitations" SET "status" = 'revoked'
WHERE "status" = 'pending'
  AND "id" NOT IN (
    SELECT DISTINCT ON ("organization_id", "email") "id"
    FROM "invitations"
    WHERE "status" = 'pending'
    ORDER BY "organization_id", "email", "created_at" DESC, "id" DESC
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_pending_idx" ON "invitations" USING btree ("organization_id","email") WHERE status = 'pending';
