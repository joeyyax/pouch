# Self-hosting

`docker-compose.self-host.yml` stands the whole stack up behind no particular reverse proxy: the app, the worker, the SMTP ingress, Postgres and Valkey. `docker-compose.traefik.yml` is the same stack behind an existing Traefik. It repeats the same services rather than including this file, and `tests/unit/compose-env-parity.test.ts` keeps their environment in step. Run the one that matches your setup; `docker-compose.yml` is the local development stack and isn't either of them.

```bash
cp .env.example .env     # fill it in, then
docker compose -f docker-compose.self-host.yml up -d
```

The app is published on `APP_PORT` (3100 by default). Put your own TLS terminator in front of it and point `APP_URL` at the public address — links in mail, webhook payloads and the unsubscribe URL all come from it.

## What you have to set

| Variable | Why |
| --- | --- |
| `APP_URL` | Every link the service mails or signs. |
| `ENCRYPTION_KEY` | Provider, DNS-provider and webhook secrets at rest. Losing it loses them. |
| `BETTER_AUTH_SECRET` | Sessions and list confirmation tokens. |
| `POSTGRES_PASSWORD` | The bundled database. Ignored if you set `DATABASE_URL`. |
| `STORAGE_*` | Where bodies and attachments live. Any S3-compatible bucket. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | The first account. Public sign-up is off, so without this nobody can sign in. |
| `SEED_PROVIDER_CREDENTIALS`, `SEED_DOMAIN` | The provider and domain the install starts with. |

`lib/config.ts` lists every variable and what goes missing without it. The app, worker and SMTP ingress check it at boot and refuse to start without one they need, or on the development secrets `.env.example` ships with, naming each.

`SUPPORT_ADDRESS` sets the address system mail comes from until an admin sets one in Admin settings → General. It defaults to `support@example.org`, which is a placeholder, not a working address.

## Settings file

Settings in Admin settings can be pinned in `pouch.yml` instead. Each setting's environment variable still wins over the file. Copy `pouch.example.yml`, uncomment what to pin, and mount it at `/app/pouch.yml` on all three services; the mount is in `docker-compose.self-host.yml`, commented out. An unknown key or a value out of bounds stops startup, naming the key. Secrets stay in the environment. docs/engineering.md, "Settings file", has the rest.

## Bodies and backups

Each body is sealed with its own key in `messages.body_key`. When retention ends, the sweep nulls the key and leaves the object in the bucket. One lifecycle rule on the bucket, strictly above `body_retention_max_days` (365 by default), collects those objects. With a storage token that can read bucket configuration, the `body-lifecycle` readiness check degrades when the rule is missing or at or under the ceiling. docs/engineering.md, "Rules", has the rest.

A Postgres backup holds every key that existed when it was taken, so a restored backup can open bodies the live database has shredded. To keep a body unreadable after retention, keep backups no longer than retention.

## Optional checks

`SPAMHAUS_DQS_KEY` turns on domain blocklist checks against Spamhaus DBL and ZRD. `NTFY_TOPIC` turns on push alerts when a health check fails twice in a row. DMARC reports need a report host, set in Admin settings → General, on a provider that receives inbound mail.

## Bundled or external Postgres and Redis

Bundled is the default and what most deployments should run — no extra setup, nothing to configure. To use a managed database or cache instead, set `DATABASE_URL` and `REDIS_URL` and start only the app services. `--no-deps` is required, or `depends_on` starts the bundled containers anyway:

```bash
docker compose -f docker-compose.self-host.yml up -d --no-deps mail mail-worker mail-smtp
```

## Search

Dashboard search runs on Postgres. For typo-tolerant matches, point `MEILISEARCH_URL` at a Meilisearch you run, with `MEILISEARCH_API_KEY` and a `MEILISEARCH_INDEX_PREFIX` the key is scoped to, then fill the index with `docker compose -f docker-compose.self-host.yml exec mail node --import tsx scripts/search-reindex.ts`. docs/engineering.md, "Search", has the rest.

## SMTP

587 with STARTTLS is published. It needs a certificate for `SMTP_TLS_HOST` on disk, in `SMTP_CERT_DIR` (`./certs`) as `certificate.crt` and `privatekey.key`, readable by uid 1001 — the user the image runs as. Without one, 587 opens with `AUTH` disabled and refuses every send rather than accepting a key in the clear: a key is a bearer credential for the whole send API.

A host that can open 465 turns on implicit TLS with `SMTP_IMPLICIT_TLS_PORT` and publishes that port too.

The key pages show `SMTP_TLS_HOST` as the host to connect to. Unset, they say the install hasn't named one.

## The image

It ships full `node_modules` rather than Next's `output: standalone`, because `scripts/migrate.ts` and `worker/index.ts` run through `tsx` at runtime. It's a bigger image than it could be; it's also the one that boots the worker and the migrations with no build-time tracing to get wrong.

## Running behind Traefik

`docker-compose.traefik.yml` does exactly that: router labels per hostname, Traefik's network (`TRAEFIK_NETWORK`) and a `traefik-certs-dumper` sidecar that turns Traefik's `acme.json` (`TRAEFIK_ACME_JSON`) into the PEMs the SMTP ingress reads.
