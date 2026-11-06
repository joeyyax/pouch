# Pouch

Transactional email service with a provider-agnostic core. The API is the product.

Product and API decisions live in `docs/`. To run it yourself, see `docs/self-hosting.md`.

## Local setup

```bash
cp .env.example .env
docker compose up -d          # Postgres 5440, Redis 6390, MinIO 9010/9011
pnpm install && pnpm dev:all  # app on 3100, worker health on 3101, SMTP on 2587
```

Nothing in `.env.example` has to change to get running. Its `SEED_*` block is set up for the
`mock` provider, which accepts every send and delivers nothing, so no provider is needed
and no mail leaves the machine; `BETTER_AUTH_SECRET` and `ENCRYPTION_KEY` ship with development
values. Generate real ones with `openssl rand -base64 32` for anything deployed.

`pnpm dev:all` runs `pnpm bootstrap` first: migrations every time, then `pnpm seed` and
`pnpm dev:data` on an empty database only. Once the admin exists it leaves the data alone, so a
restart never clears messages you sent by hand. `pnpm seed` prints the first API key — it scrolls
past in the bootstrap output, and `pnpm dev:data` prints the sign-in providers and their shared
password.

`pnpm dev:data` fills the database with six months of seeded, reproducible history relative to now:
five sending domains plus pending and failed ones, ~15k messages across the whole lifecycle with
their events, keys, lists and batches, inbound mail, webhooks, suppressions and activity. Pass a
scenario: `good` (all healthy), `okay` (a domain on watch, a backlog) or `bad`, the default (a
paused domain, a recent complaint, the provider backing off). `pnpm dev:data clear` empties the
messages, `pnpm dev:data reset` removes everything it made, `pnpm dev:reset [scenario]` does both
and fills again, and re-running a fill replaces the message set rather than doubling it.

### Seeding a real deployment

`pnpm seed` is the production bootstrap, not the development one. It creates the admin, the
organization, its provider, its domain and the first API key, and it fails unless `ADMIN_EMAIL`,
`ADMIN_PASSWORD`, `SEED_PROVIDER_CREDENTIALS` and `SEED_DOMAIN` are all set — see the `SEED_*`
block in `.env.example`. It also builds the provider's event plumbing: on SES the organization sends
through a shared provider, which gets an SNS topic, and SES confirms the subscription by calling `APP_URL`, so
run it with the app already up.

A forgotten password is reset from the login screen's "Forgot password?" link, which emails a
one-hour, single-use link from the system from address. When
that isn't set up, or the mail doesn't arrive, `pnpm reset:admin` sets a new password from the host:

```bash
RESET_ADMIN_EMAIL=you@example.com RESET_ADMIN_PASSWORD='...' pnpm reset:admin
```

It refuses to create a provider and revokes every session that one holds. In a container:
`docker compose exec mail sh -c 'RESET_ADMIN_EMAIL=... RESET_ADMIN_PASSWORD=... pnpm reset:admin'`.

## Sending

```bash
curl http://localhost:3100/v1/emails \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-1" \
  -d '{"from":"Ada <ada@example.com>","to":"person@example.net","subject":"Hello","html":"<p>Hi</p>"}'
```

The response is `202` with the message id and `status: "queued"`. Read it back with
`GET /v1/emails/:id`, which carries the current state and the event timeline.

A key beginning `sk_test_` routes every send to the mock provider: nothing leaves the
building, and a recipient whose local part is `bounce`, `defer` or `slow` exercises the
failure, retry and backoff paths.

## Layout

| Path | What lives there |
|---|---|
| `app/api/v1/` | Versioned REST, key-authenticated |
| `app/api/auth/` | Better Auth catch-all |
| `app/(app)/` | Dashboard, session-authenticated |
| `lib/providers/` | Providers: encrypted credentials, admin writes, assignments and sharing |
| `lib/providers/adapters/` | One file per email service, all implementing `Adapter` |
| `lib/messages/` | Queue, lifecycle, suppression, idempotency |
| `lib/storage/` | Message bodies and attachments in object storage |
| `worker/` | Send loop; reaches the app only through Postgres and Redis |

## Storage

Bodies and attachments go to object storage under an opaque `bodies/<random>` key, encrypted
with a per-message key kept on the message row — the bucket on its own is worthless. How long
the key survives is `organizations.body_retention_days` (default 45, range 7-365); a worker
sweep shreds keys past the boundary, and one bucket lifecycle rule above the range collects
the inert objects. MinIO locally, R2 in production. Nothing puts a body in Postgres.

## Tests

```bash
pnpm test        # typecheck, lint and vitest
pnpm test:unit   # unit tests only; still needs the compose stack
```

Integration tests need the compose stack up. Each checkout gets its own test database
(`mail_test_<hash>`, created on first run), Redis key prefix and MinIO prefix, so suites in
separate worktrees and `pnpm dev:all` can share the stack.

## Ports

The app is 3100 and the worker health endpoint is 3101. Compose maps Postgres to 5440,
Redis to 6390 and MinIO to 9010 and 9011, off their defaults so several projects can run
side by side.

## Contributing

`CONTRIBUTING.md` covers the setup, what a change needs and the rules that hold across the
codebase. Report a vulnerability privately — see `SECURITY.md`.

## License

AGPL-3.0-only. Self-host it, modify it, run it for yourself freely; run a modified copy as a
service for other people and you owe them the source. See `LICENSE`.

`sdk/` is MIT, so importing the client into a closed application carries no obligation.
