# CLAUDE.md

Transactional email service with a provider-agnostic core. The API is the product.

Read before writing code:

- `docs/engineering.md` — stack, layout, and the rules that hold across the codebase
- `docs/decisions.md` — what was chosen, why, and what would change it. Read it before undoing one.
- `docs/product/brief.md` — what it is, what it isn't, principles, concepts
- `docs/product/model.md` — the nouns, how they relate, what belongs to whom
- `docs/product/voice.md` — copy, errors, empty states
- `docs/api/conventions.md` — naming, errors, pagination, webhooks, test mode

One GitHub issue per increment.

## Commands

```bash
docker compose up -d # Postgres, Redis and MinIO; dev and tests need it
pnpm dev:all        # bootstrap, then app, worker and SMTP
pnpm dev            # app only
pnpm dev:worker     # worker
pnpm dev:smtp       # SMTP submission
pnpm test           # observations check + typecheck + lint + check:docs + vitest
pnpm test:unit      # unit tests only; still needs the compose stack
pnpm test:load      # accept and send throughput against the mock provider
pnpm db:generate    # new migration
pnpm db:migrate     # apply migrations
```

# This is NOT the Next.js you know

Next 16 has breaking changes — APIs, conventions and file structure may differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing code, and heed deprecation notices.
