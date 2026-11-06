-- Strips addresses from single-address list activity (#352). Rows whose member or domain stop still exists get its id instead.
UPDATE "activity" SET "metadata" = ("metadata" - 'address') || jsonb_strip_nulls(jsonb_build_object('membershipId', (
  SELECT m."id" FROM "list_memberships" m
  WHERE m."list_id" = "activity"."applies_to" AND m."organization_id" = "activity"."organization_id" AND m."address" = "activity"."metadata"->>'address'
)))
WHERE "family" = 'list' AND "action" IN ('list.member.added', 'list.unsubscribed') AND "metadata" ? 'address';
--> statement-breakpoint
UPDATE "activity" SET "metadata" = ("metadata" - 'address') || jsonb_strip_nulls(jsonb_build_object('domainUnsubscribeId', (
  SELECT d."id" FROM "domain_unsubscribes" d
  WHERE d."domain_id" = "activity"."applies_to" AND d."organization_id" = "activity"."organization_id" AND d."address" = "activity"."metadata"->>'address'
)))
WHERE "family" = 'list' AND "action" = 'domain.unsubscribed' AND "metadata" ? 'address';
--> statement-breakpoint
UPDATE "activity" SET "metadata" = "metadata" - 'address'
WHERE "family" = 'list' AND "action" = 'list.member.removed' AND "metadata" ? 'address';
