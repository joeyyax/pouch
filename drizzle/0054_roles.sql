-- #376. `users.operator` becomes `users.admin`, and `memberships.role` becomes owner | member.
-- See docs/decisions.md, "Admin is service-wide; an organization has owners and members".
ALTER TABLE "users" RENAME COLUMN "operator" TO "admin";--> statement-breakpoint

-- Org-level `admin` was a lesser owner with the same powers on every guarded action, so it
-- becomes `owner`. A user holding both rows in one organization can't exist — the unique index
-- on (user_id, organization_id) — so there's nothing to collapse.
UPDATE "memberships" SET "role" = 'owner' WHERE "role" = 'admin';--> statement-breakpoint

-- Stops rather than guessing. A role no version of this app wrote means the data disagrees
-- with the code, and picking one on its behalf hides that. The constraint below would refuse it
-- too, but as a bare 23514 that doesn't say which value or which row.
DO $$
DECLARE unknown_roles text;
BEGIN
  SELECT string_agg(DISTINCT "role", ', ') INTO unknown_roles
  FROM "memberships" WHERE "role" NOT IN ('owner', 'member');

  IF unknown_roles IS NOT NULL THEN
    RAISE EXCEPTION 'memberships hold roles this version does not recognize: %. Map each one to owner or member, then run this again.', unknown_roles;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role_check" CHECK ("memberships"."role" in ('owner', 'member'));
