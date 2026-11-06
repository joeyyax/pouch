# Contributing

## Getting it running

The steps are in `README.md` and they work from a plain copy of `.env.example` — no provider, no AWS, no mail leaving the machine. If any of them fails on a clean clone, that's a bug worth an issue on its own.

```bash
cp .env.example .env
docker compose up -d
pnpm install && pnpm dev:all
```

## Before you open a pull request

```bash
pnpm test     # typecheck, lint, the API docs check, then 1600+ vitest tests
pnpm build
```

Run both. A green typecheck misses bundling and route problems, which is what the build catches.

Integration tests need the compose stack up. They create their own database per checkout, so they won't touch your development data.

## What a change needs

- **A test that can fail.** Not a mirror of the configuration and not an assertion about a type's shape — something that goes red if the behavior regresses.
- **The docs updated in the same change.** A new error code goes in the table in `docs/api/conventions.md`. A new request field needs a `.describe()` or the build fails. A decision that took thought goes in `docs/decisions.md` — what you chose, why, and what would change it.
- **A migration generated, not hand-written.** `pnpm db:generate` after a schema edit.
- **A migration the running release survives.** A deploy runs the old code against the new schema until the new one is healthy. Add columns and tables freely; a drop, a rename or a `SET NOT NULL` ships one release after the code stops using the column. A statement that waits 10 seconds for a lock fails the deploy (`scripts/migrate.ts`).

## The rules that hold across the codebase

They're in `docs/engineering.md` and they're short. The ones people trip over:

- Every table has `organization_id`, and every query that reads one filters on it.
- Adapters implement `Adapter` and nothing else reaches a provider SDK.
- Delivery events only. Nothing tracks opens or clicks, and that's a product decision, not an omission.
- A timestamp the database will compare against another comes from `dbNow()`, never `new Date()`. Mixing the app's clock with Postgres `now()` makes what's due depend on the skew between two machines.
- The product name lives in `lib/brand.ts` and appears in no identifier, env var, table or route.
- A provider 429 is a backoff on that account, never a failed message.

`docs/decisions.md` records what was already decided and why. Read it before undoing one — if the reasoning is wrong, say so in the pull request rather than quietly reversing it.

## Adding a provider

One file in `lib/providers/adapters/` implementing `Adapter`, plus its descriptor in the registry in `lib/providers/adapters/index.ts`. `lib/providers/adapters/mock.ts` is the shortest complete example and `lib/providers/adapters/types.ts` documents what each method may and may not assume. Capabilities are declared, not inferred: an adapter that can't carry custom headers says so and the core routes around it.

## Style

Comments say what the thing does and stop. No restating what the code says, no defending a decision in the source — reasoning goes in the pull request body or `docs/decisions.md`, once.

## Licence

Contributions are made under AGPL-3.0-only, except `sdk/`, which is MIT. By opening a pull request you're agreeing to that.
