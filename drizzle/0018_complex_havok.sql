-- Account names are now unique per organization, not per organization and module.
-- Resolve existing cross-module duplicates first: the oldest row keeps its name,
-- later ones get their id appended so the new index can't fail on insert.
with ranked as (
  select id, row_number() over (
    partition by organization_id, name
    order by created_at asc, id asc
  ) as rn
  from provider_accounts
)
update provider_accounts
set name = provider_accounts.name || ' (' || provider_accounts.id || ')'
from ranked
where provider_accounts.id = ranked.id
  and ranked.rn > 1;
--> statement-breakpoint
DROP INDEX "provider_accounts_name_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "provider_accounts_name_idx" ON "provider_accounts" USING btree ("organization_id","name");
