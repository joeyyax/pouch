# Engineering

How this codebase is built and the rules that hold across it. Product shape is in `product/brief.md`, the model in `product/model.md`, copy in `product/voice.md`, the API surface in `api/conventions.md`.

This file is for what is specific to this app.

## Stack

Next.js 16 App Router, TypeScript strict, pnpm. Postgres via Drizzle, Redis for live updates. Better Auth. zod. React Email for Pouch's own mail. Separate worker process for sending. Pouch's own install runs at app.pouch.email from `docker-compose.vardo-production.yml`; `docker-compose.traefik.yml` is the portable `docker-compose.self-host.yml` behind an existing Traefik (see docs/self-hosting.md). `docker-compose.yml` is the local dev stack.

## Layout

```
app/
  api/v1/          versioned REST, key-authenticated
  api/auth/        Better Auth catch-all
  api/webhooks/    provider callbacks, signature-verified
  client-errors/   browser render errors, unauthenticated, into the scrubbed reporter
  (app)/           dashboard, session-authenticated
    _ui/           Pouch's own dashboard components
  styles/          the kit's CSS, from @uikit/base
  brand.css        Pouch's token values
components/ui/     the kit, from the @uikit registry
lib/
  brand.ts         the only place the product name lives, as display copy
  wire.ts          the frozen token that goes out on the wire — headers, export filenames
  config.ts        every environment variable, checked when each process boots
  db/schema/       Drizzle schema
  auth/            Better Auth server, session helpers
  schemas/         zod request and response schemas; docs generate from these
  providers/       providers: encrypted credentials, admin writes, assignments and sharing
    adapters/      one file per email service, all implementing Adapter
  messages/        queue, lifecycle, suppression
  domains/         verification flow, DNS checks and the DMARC read
  dmarc/           DMARC aggregate reports: the report host, ingest, reads
  notifications/   owner email: the type registry, preferences and the throttle
  dashboard/       one loader per screen; views/ holds the shapes it renders
  activity/        taxonomy (retention and client policy per action), record, query, retention, labels
  system/          service-wide admin reads, shared with the worker's alert loops
  worker/          what loops are built from: IntervalLoop for sweeps, rollingPass for queues that wait on others
worker/            the loops the worker runs; talks to the app only through Postgres and Redis
docs/              product, API and engineering docs
docs-site/         pouch.email/docs: Fumadocs, built into the site image (site/README.md)
site/              pouch.email's landing page and the Caddy image that serves it and the docs
```

## API docs

`lib/api-docs/spec.ts` is the source: each route's request and query zod schemas, response fields and errors. Everything else reads it.

- `/openapi.json` on every install (`lib/api-docs/openapi.ts`), with the install's `APP_URL` as its server. `tests/unit/openapi.test.ts` holds it to the spec and the handlers under `app/api/v1`.
- pouch.email/docs/reference, rendered by fumadocs-openapi from the same document with the server left as a variable the reader fills in.
- `/llms.txt`, `/llms-full.txt` and the MCP tools.

`lib/api-docs/links.ts` maps a route to its docs page. The app's `/reference` redirects to the docs site.

## Setup

Admins own every provider. A production install runs these once, in order, with the app up:

1. `pnpm seed`: the admin, the first organization, its provider, its domain and a key. On SES the provider is a shared provider the organization sends through. Set `SEED_PROVIDER_CREDENTIALS` and `SEED_DOMAIN` first.
2. **On SES, set the default provider** in Admin settings → General. Providers themselves are created in Admin settings → Providers.

`pnpm seed` prints the domain's DNS records.

Without step 2, a new organization has no provider and can't add a domain until an admin assigns one.

### System mail

Pouch's own mail — password resets, sign-in links, invitations, owner notifications, admin alerts, digests — sends from the **system from address** in Admin settings → General. A local part and a select of verified domains, stored as a full address. Its domain has to be verified in some organization, whose provider sends it. Admin alerts go to the **system alerts to** addresses beside it, or to the from address while that's unset.

Unset, it's `support@` on the first verified domain on the install, so one admin with one organization and one domain needs to configure nothing.

The messages belong to the service (`messages.organization_id` null, `acceptServiceMessage` in `lib/messages/create.ts`). No organization's log, API, MCP, export or search returns them, and their events fire no webhook. Admin settings → Status → System mail lists them (`lib/system/service-mail.ts`). The carrying organization's suspension and its domain's pause still hold them, and they count toward that domain's pause lines and reputation, since its provider sees them. A bounce or complaint suppresses the address on the system mail list, shown on the same screen, and never on the carrier's.

Until it resolves to a verified domain, "Forgot password?" answers 503 and says so, the login screen disables "Email me a sign-in link" with the reason, and `pnpm reset:admin` on the host is the way back in.

### DMARC reports

Optional. Without a report host, domains get `v=DMARC1; p=none;` and no reports. To turn them on, as an admin:

1. **A shared provider that routes received mail through its API**: SES with an inbound bucket and an active receipt rule set (see "SES inbound").
2. **Admin settings → Reputation → DMARC reports**: a host nothing else receives on, such as `reports.pouch.email`, and that provider. Saving opens the route there.
3. **Publish the records the card lists** at the host's DNS: the provider's MX for the host and `*._report._dmarc.<host>` TXT `v=DMARC1`, which authorizes reports about every domain (RFC 7489 §7.1). "Check again" reads them live; once they match, every domain's recommended DMARC record carries its own `rua`.

Clearing the host takes the route down and drops the `rua` from recommendations. Code is in `lib/dmarc/`; see docs/decisions.md, "DMARC reports come to one host the admin owns, one address per domain".

Password reset (`lib/auth/password-reset.ts`):

- Better Auth's `/request-password-reset`, answered the same whether or not the address has a provider. The send runs in the background so a known address doesn't answer slower.
- Rate-limited in Redis before Better Auth sees it: `PASSWORD_RESET_RATE_LIMIT` per client address (5) and `PASSWORD_RESET_EMAIL_RATE_LIMIT` per email address (3), each per minute.
- Tokens last one hour, work once and are stored hashed. A reset signs out every session the provider holds.
- Mail that carries a credential (reset, sign-in link, invitation, forwarding confirmation) passes `withhold` to `sendSystemMail`. Its body is never returned by any read, and the retention sweep shreds the key once the message leaves `queued`.
- A send with `sensitive: true`, or `X-Pouch-Sensitive: 1` over SMTP, is withheld the same way with an empty reason (`lib/messages/create.ts`, `lib/smtp/parse.ts`).
- Activity records `session.password_reset.requested` and `session.password_reset.completed` on the provider's organization.

Sign-in methods (`lib/auth/index.ts`, `lib/auth/magic-link.ts`):

- Password, passkey and emailed link. A link never creates an account; an unknown address gets the same answer and no mail.
- Links last 10 minutes, work once and are stored hashed. The email goes to `/login/link`, whose button redeems it, so a mail scanner can't spend it.
- Rate-limited in Redis before Better Auth sees it: `MAGIC_LINK_RATE_LIMIT` per client address (5) and `MAGIC_LINK_EMAIL_RATE_LIMIT` per email address (3), each per minute.
- Passkey and link sign-ins record `session.signed_in` from the `hooks.after` in `lib/auth/index.ts`, with `metadata.method`. A password sign-in records it through `recordSignInAction`. Requests record `session.magic_link.requested`.
- Passkey sign-in requires user verification (`lib/auth/passkey.ts`), and the last credential on a password-less account can't be removed, through the API either.
- /login leads with the sign-in link and the passkey, and reveals the password on request (`?method=password`). Without system mail the password form is open and the link option is absent.
- The login email field carries `autocomplete="email webauthn"`, so browsers offer passkeys there.
- Each method is a registry entry (`sign_in_password`, `sign_in_passkey`, `sign_in_magic_link`). One that's off is gone from /login and refused at its Better Auth endpoints by `signInMethodsGuard` (`lib/auth/sign-in-methods.ts`). One always stays on, and no admin is left without a way in.
- `session_days` (1 to 90, 7 by default) is read once by `register()`, so a change needs a restart.

Invitations (`lib/invitations/`):

- An owner invites an address on Settings → Members; an admin key does the same on `/v1/admin/organizations/:id/invitations`. Mail carries a one-time token to `/accept`.
- One live invitation per address per organization, 7-day TTL, revocable and re-sendable. Resending issues a new token and kills the old link.
- Rate-limited in Redis: `INVITE_RATE_LIMIT` per organization (10) and `INVITE_EMAIL_RATE_LIMIT` per invited address (3), each per minute.
- An address that already has an account joins it from a signed-in session. A token never sets a password on an existing account.
- While password sign-in is off, a new account gets no password: accepting signs it in and offers a passkey (`lib/auth/invitation-session.ts`).

## UI kit

The kit comes from uikit's shadcn registry under `@uikit` (`components.json`, `UIKIT_REGISTRY_URL`). Every kit file is a copy uikit owns: `components/ui/`, `app/styles/` and the kit's files in `lib/` and `hooks/`. They're never edited here.

- Pouch's brand is `app/brand.css`: the values of every token the kit reads, imported after the kit's styles. A look change that's Pouch's alone goes there.
- A component only Pouch needs lives in `app/(app)/_ui/` or `components/`, never `components/ui/`.
- A kit bug or a missing prop is fixed in uikit by PR, then comes back through the registry.
- `pnpm shadcn add @uikit/<item>` installs a new item and what it depends on.

Updating:

1. A shadcn upstream change worth having is ported into uikit, which reviews it with `shadcn add <x> --diff` in a scratch app and runs its tests and a11y checks.
2. uikit merges and rebuilds the registry (`pnpm registry:build`).
3. Here, `pnpm uikit --dry-run` lists what would change, `pnpm uikit --diff <file>` shows one file and `pnpm uikit --overwrite` takes it all. `--diff` on a single item works too: `pnpm shadcn add @uikit/<item> --diff`.
4. `pnpm test`, then `pnpm design:shots` before and after when the change is visual.

The CLI drops a kit file's leading comment, so a copy here can read shorter than uikit's source.

## Deployment

Both deployment files support two shapes.

**Bundled (the default, and the recommended shape):** Postgres and Redis run alongside the app and worker, exactly as `docker compose -f docker-compose.self-host.yml up -d` starts them. `DATABASE_URL` and `REDIS_URL` default to the bundled containers when unset, and `mail`/`mail-worker` still `depends_on` them with `condition: service_healthy`. This is what most self-hosted deployments should run — no extra setup, no variables required.

**External:** for a deployment that already has a managed Postgres or Redis, set `DATABASE_URL` and/or `REDIS_URL` to point at it, then start only the app services — `--no-deps` is required, or `depends_on` starts the bundled containers anyway: `docker compose -f docker-compose.self-host.yml up --no-deps mail mail-worker`.

A compose profile was the first approach here and it's wrong: profiles are opt-in, not opt-out, so a profiled `postgres`/`redis` would never start without an environment variable set first — on a repo that deploys on merge to `main`, that's a trap, and it makes a fresh clone's default `docker compose up` come up with no database. Naming services explicitly, with `--no-deps` to defeat `depends_on`, gets the same optionality without changing what the ordinary path does.

Redis is deliberately non-persistent (`--save "" --appendonly no`). Nothing durable lives there — the record is Postgres — so a managed Redis needs no persistence, no backups and can run on the cheapest tier available.

`mail-worker`'s `stop_grace_period` (135 s) has to cover `SHUTDOWN_DRAIN_TIMEOUT_MS` plus the teardown hooks. Change them together (see docs/decisions.md, "A shutdown hook is a drain by flag, and drains run together").

The app runs its shutdown hooks inside Next's exit: `instrumentation.ts` wraps `process.exit`, so hooks start after Next has stopped accepting and finished pending requests (see docs/decisions.md, "The app's shutdown hooks run inside Next's own exit").

The migrator (`scripts/migrate.ts`) takes a Postgres advisory lock before applying migrations, so running the app and worker as separate deployables, or scaling either past one replica, can't apply the same migration twice or race mid-migration.

Plain `docker compose up` ignores the compose `deploy:` block (replicas, `update_config`), so these files leave it out. Scale `mail` with `--scale mail=2`.

The repo has no CI, and a merge to `main` deploys. The `gate` stage in the `Dockerfile` runs typecheck, lint, `check:docs` and the unit tests (`vitest.unit.config.ts`) beside the build, and the runner copies its marker file, so a failing tree builds no image and the old containers keep serving. Integration tests need Postgres and Redis and stay out: run `pnpm test` before you merge.

### Settings file

`pouch.yml` pins entries in the settings registry. Resolution is the entry's environment variable, then the file, then Admin settings (`service_settings.settings`), then the default, so a variable is the override for an incident. A value either sets shows locked in the dashboard, naming the one that won: "Set in pouch.yml" or "Set by FEATURE_BULK". Boot warns when a variable overrides the file.

- **Where.** `CONFIG_FILE`, or `pouch.yml` in the working directory: `/app/pouch.yml` in the image. Both compose files carry the mount, commented out. Create the file before mounting it, since Docker turns a missing source into a directory.
- **Shape.** Flat keys, the registry's own: `bulk: false`, `stall_bounce_percent: 1.5`. `pouch.example.yml` lists every key at its default, and a unit test keeps it in step with the registry.
- **Boot.** The app, worker and SMTP ingress check the file and the registry variables in `checkBootConfig` (`lib/config.ts`), one check for both. A variable or key whose value is outside its entry's type or bounds, an unknown key, malformed YAML or a `CONFIG_FILE` that names a missing file stops the process, naming each problem. No file at the default path is fine.
- **Changes.** Read once per process, so a change takes a restart.
- **Export.** Admin settings → General → Export settings downloads the file (`/api/dashboard/settings/export`, admins only). A value off its default is set and every default is a commented-out line, so dropping it in as `pouch.yml` pins only what was changed and still lists every key.
- **Secrets.** Never in this file. They stay in the environment, and a key like `ENCRYPTION_KEY` fails boot.

The loader, `lib/config-file.ts`, knows nothing about Pouch: a default file name in, a mapping out. `lib/settings/file.ts` checks it against the registry.

### Providers

Admins create, rotate and delete every provider and assign each organization one, in Admin settings or the admin API (`docs/api/admin.md`). Organizations read their assigned provider on Settings → Sending and never write it.

An SES account serves every organization assigned to it as an SES tenant, with its own reputation, configuration set and suppression list. A Mailpace or Cloudflare account serves the one organization it's created for.

To add an SES account:

1. **AWS account** with SES production access. For customer mail, request it as sending on behalf of customers, and check the SES pricing page for the per-tenant charge.
2. **IAM user** with the shared-provider policy in "IAM policies".
3. **Admin settings → Providers → Add provider.** Pouch checks the credentials, then creates an SNS topic, an EventBridge rule on the default bus for SES tenant status and the subscription to `/api/webhooks/ses/<provider id>`. The provider reads "ready" once SNS confirms, which needs the app reachable at `APP_URL`.
4. **Assign organizations** with "Assign organization" on the provider's page or "Assign provider" in Admin settings → Organizations, and name one provider the default in Admin settings → General.

Assigning inserts the organization's tenant row, holding a copy of the shared credentials, and calls nothing at AWS. The organization's first domain on the provider creates the tenant (tenant-scoped suppression), a configuration set with its own SNS topic and the associations, which adds about nine seconds to that request. Rotating credentials rewrites every copy in one statement. Unassigning is refused while a domain uses the provider, and deletes the tenant, its configuration set, topic and suppression list. SES allows 10,000 tenants and 10,000 configuration sets per Region by default; raise both in Service Quotas before a provider nears that.

**Public signups stay off** (`disableSignUp` in `lib/auth/index.ts`) until #292 caps domains and send volume per organization, counting domains per user too. An invitation is how an account is created in the meantime.

A throttle on any tenant backs off the whole shared provider. Tenant sends share a rate in Redis, sized from the provider's `MaxSendRate`. The health check probes a rotating sample of tenants, since SES allows one non-send API call a second per provider. Every non-send SES call waits for a permit from one Redis bucket per AWS account. See docs/decisions.md.

SES reports a paused tenant through EventBridge. `Sending Status Disabled` suspends the organization with source `provider`, which refuses new sends and holds queued mail. `Sending Status Enabled` releases it only when the provider set the suspension, and the held mail sends. Reputation findings are logged on the organization's activity, and a high-impact one pushes an alert. An hourly `ListRecommendations` read opens findings an event missed and closes ones SES no longer lists.

The health loop also reads each provider's send quota (`GetAccount`) and its CloudWatch reputation rates, and caches both in Redis for the system view (`lib/providers/provider-metrics.ts`). Without `cloudwatch:GetMetricData` the view says so and nothing else changes.

### SES inbound

Optional, per provider. Without an inbound bucket and an active receipt rule set, enabling inbound on an SES domain returns `capability_unavailable`. Once per AWS account and region, as an admin:

1. **Receipt rule set.** `aws ses describe-active-receipt-rule-set --region <region>`. If none is active, `aws ses create-receipt-rule-set --rule-set-name pouch-inbound` and `aws ses set-active-receipt-rule-set --rule-set-name pouch-inbound`. Pouch never creates, activates or replaces one.
2. **Bucket** in the provider's region, public access blocked. Its policy lets SES write under `inbound/` and refuses plain HTTP:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "PouchSesInbound",
         "Effect": "Allow",
         "Principal": { "Service": "ses.amazonaws.com" },
         "Action": "s3:PutObject",
         "Resource": "arn:aws:s3:::<bucket>/inbound/*",
         "Condition": {
           "StringEquals": { "AWS:SourceAccount": "<account id>" }
         }
       },
       {
         "Sid": "TlsOnly",
         "Effect": "Deny",
         "Principal": "*",
         "Action": "s3:*",
         "Resource": ["arn:aws:s3:::<bucket>", "arn:aws:s3:::<bucket>/*"],
         "Condition": { "Bool": { "aws:SecureTransport": "false" } }
       }
     ]
   }
   ```

   Keep the condition to `AWS:SourceAccount`: an `AWS:SourceArn` condition makes SES's write fail.

   Add a lifecycle rule expiring `inbound/` after 7 days. Pouch deletes each object once it's ingested, so anything older is mail SNS gave up on: replay it within the week (below).
3. **IAM**: the policy in "IAM policies" below.
4. **The provider's credentials**: re-enter them with `inboundBucket` set (Admin settings → Providers → Rotate credentials). Rotation copies it to every tenant.

Enabling inbound on a domain then adds a receipt rule for `<subdomain>.<domain>` to the active set: first in the set, ending in a stop action, so the account's own rules never see a Pouch host's mail. SES checks it can write the bucket and publish to the provider's topic before it takes the rule, and a refusal comes back as `capability_unavailable` with SES's reason. Disabling inbound or deleting the domain deletes the rule, and a move re-creates it on the new provider. See docs/decisions.md.

A message that fails SES's virus scan keeps its metadata and verdicts, and none of its content: no attachments, no raw message, no links.

**Replaying mail SNS gave up on.** SNS retries an announcement for about 52 minutes. Past that, the message sits in the bucket until the lifecycle rule takes it. List what's left and replay it; a message already stored counts as a duplicate, so a replay is safe to repeat:

```bash
aws s3 ls s3://<bucket>/inbound/ --recursive
docker compose exec mail node --import tsx scripts/replay-inbound.ts <provider id> inbound/<domain id>/<message id> ...
```

Nothing lists the bucket on its own yet. A worker sweep would need the `s3:ListBucket` grant below, which the policy already carries.

**Rollback:**

1. `PATCH /v1/domains/:id/inbound` with `{ "enabled": false }` on each SES domain, which deletes its rule. If Pouch can't, `aws ses delete-receipt-rule --rule-set-name <set> --rule-name mail-inbound-<domain id>`.
2. Put the domain's previous inbound DNS back, or remove the MX.
3. Replay or download anything still under `inbound/` before the lifecycle rule takes it.
4. Reverting the code needs nothing else: migration 0061 only adds columns.
5. If the scoped IAM policy breaks outbound, attach AmazonSESFullAccess and AmazonSNSFullAccess again, then find the missing action in CloudTrail.

### Blocklist checks

Optional. Set `SPAMHAUS_DQS_KEY` on `mail` and `mail-worker` to a Spamhaus DQS key; unset turns the checks off. The free key is for non-commercial use under 100,000 queries a day. Queries go through the host's resolver, and Redis counts them. See docs/decisions.md.

### Search

Optional. Set `MEILISEARCH_URL`, `MEILISEARCH_API_KEY` and `MEILISEARCH_INDEX_PREFIX` on `mail`, `mail-worker` and `mail-smtp` to add typo-tolerant matches to dashboard search; unset leaves search on Postgres alone. The key needs write and search on `<prefix>*` indexes, including creating them and changing their settings. Fill the index once after turning it on, and again after an outage:

```bash
docker compose exec mail node --import tsx scripts/search-reindex.ts          # everything
docker compose exec mail node --import tsx scripts/search-reindex.ts --fresh  # empty first
```

Run it with `--fresh` once after migration `0086_service_mail`, which moves system mail out of the organization that carried it.

What's copied and why it can't leak across organizations is in docs/decisions.md, "Search copies the fields it searches, never a body".

### Sealing inbound mail stored before #487

Inbound rows written before bodies were sealed keep text and HTML in Postgres and their objects in plaintext until this runs once. Deploy first (migration `0067_inbound_sealed_bodies` only adds columns, and every reader handles both shapes), then:

```bash
docker compose exec mail node --import tsx scripts/seal-inbound.ts --dry-run   # count
docker compose exec mail node --import tsx scripts/seal-inbound.ts             # seal
```

It works in batches of 100 rows, 4 at a time (`--batch`, `--concurrency`), and prints progress per batch. Expect roughly 40 rows a second against R2, more for rows without attachments. It ends with the count still holding plaintext; anything left is past retention and goes with the next inbound sweep. It also nulls bodies in stored webhook payloads whose message is already gone. Interrupted or failed, run the same command again: a row stays plaintext until its update commits, and a rerun re-deletes plaintext a stopped run left behind. Exit code 1 means a row or delete failed; the log names it.

### IAM policies

Derived from the actual SDK calls `lib/providers/adapters/ses/` and `lib/providers/shared.ts` make, not from `AmazonSESFullAccess`. `Resource: "*"` throughout: SES can't scope `CreateEmailIdentity` or `TagResource` to an identity that doesn't exist yet, and the configuration set and topic names are generated per provider, so a narrower `Resource` buys nothing without hardcoding IDs the setup flow itself creates.

**A legacy SES provider** (one organization, its own credentials, not yet converted into a tenant):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PouchSesOrdinaryProvider",
      "Effect": "Allow",
      "Action": [
        "ses:SendEmail",
        "ses:SendRawEmail",
        "ses:GetAccount",
        "ses:CreateEmailIdentity",
        "ses:TagResource",
        "ses:GetEmailIdentity",
        "ses:DeleteEmailIdentity",
        "ses:PutEmailIdentityMailFromAttributes",
        "ses:CreateConfigurationSet",
        "ses:CreateConfigurationSetEventDestination",
        "ses:GetConfigurationSet",
        "cloudwatch:GetMetricData",
        "sns:CreateTopic",
        "sns:SetTopicAttributes",
        "sns:Subscribe",
        "sns:ConfirmSubscription",
        "sts:GetCallerIdentity"
      ],
      "Resource": "*"
    }
  ]
}
```

`ses:SendRawEmail` is there because every send passes `Content.Raw` to `SendEmail`, which IAM authorizes as `SendRawEmail`.

`ses:TagResource` is there because `CreateEmailIdentity` tags the identity with its owner in the same call (see "An SES identity belongs to the provider that tagged it" in `docs/decisions.md`) — SES treats that as authorizing both actions, so a policy without it makes every domain create fail.

**A shared provider** (#302), the only kind an admin creates for SES, needs the legacy policy's actions plus tenants, teardown and conversion:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PouchSesSharedProvider",
      "Effect": "Allow",
      "Action": [
        "ses:SendEmail",
        "ses:SendRawEmail",
        "ses:GetAccount",
        "ses:CreateEmailIdentity",
        "ses:TagResource",
        "ses:GetEmailIdentity",
        "ses:DeleteEmailIdentity",
        "ses:PutEmailIdentityMailFromAttributes",
        "ses:CreateConfigurationSet",
        "ses:DeleteConfigurationSet",
        "ses:CreateConfigurationSetEventDestination",
        "ses:GetConfigurationSet",
        "ses:CreateTenant",
        "ses:DeleteTenant",
        "ses:GetTenant",
        "ses:CreateTenantResourceAssociation",
        "ses:DeleteTenantResourceAssociation",
        "ses:PutTenantSuppressionAttributes",
        "ses:ListRecommendations",
        "ses:ListSuppressedDestinations",
        "ses:PutSuppressedDestination",
        "cloudwatch:GetMetricData",
        "sns:CreateTopic",
        "sns:SetTopicAttributes",
        "sns:Subscribe",
        "sns:ConfirmSubscription",
        "sns:DeleteTopic",
        "events:PutRule",
        "events:PutTargets",
        "sts:GetCallerIdentity"
      ],
      "Resource": "*"
    }
  ]
}
```

`cloudwatch:GetMetricData` reads the provider's `Reputation.BounceRate` and `Reputation.ComplaintRate`, and each tenant's `Sends`, `Bounces` and `Complaints`. It's optional: without it the system view shows "Needs cloudwatch:GetMetricData" and the provider's health is unaffected. `ses:ListRecommendations` is the shared provider's backstop for tenant findings.

`ses:DeleteConfigurationSet`, `ses:DeleteTenant*` and `sns:DeleteTopic` are absent from the ordinary policy because only a tenant provider's offboarding (`teardownTenant`) calls them. `events:PutRule` and `events:PutTargets` are only for the one-time EventBridge rule that carries tenant status to the shared provider's own SNS topic. `ses:ListSuppressedDestinations` and `ses:PutSuppressedDestination` are only for a conversion's suppression copy, which also needs `iam:SimulatePrincipalPolicy` (see "Converting a legacy SES account"). `ses:GetConfigurationSet` checks what's gone when a send gets a `NotFoundException`.

**The production user** (`pouch`: one shared provider, inbound on, conversion done) gets exactly this, in place of AmazonSESFullAccess and AmazonSNSFullAccess:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PouchSesOutbound",
      "Effect": "Allow",
      "Action": [
        "ses:SendEmail",
        "ses:SendRawEmail",
        "ses:GetAccount",
        "ses:CreateEmailIdentity",
        "ses:TagResource",
        "ses:GetEmailIdentity",
        "ses:DeleteEmailIdentity",
        "ses:PutEmailIdentityMailFromAttributes",
        "ses:CreateConfigurationSet",
        "ses:DeleteConfigurationSet",
        "ses:CreateConfigurationSetEventDestination",
        "ses:GetConfigurationSet",
        "ses:CreateTenant",
        "ses:DeleteTenant",
        "ses:GetTenant",
        "ses:CreateTenantResourceAssociation",
        "ses:DeleteTenantResourceAssociation",
        "ses:PutTenantSuppressionAttributes",
        "ses:ListRecommendations",
        "ses:ListSuppressedDestinations",
        "ses:PutSuppressedDestination",
        "cloudwatch:GetMetricData",
        "sns:CreateTopic",
        "sns:SetTopicAttributes",
        "sns:Subscribe",
        "sns:ConfirmSubscription",
        "sns:DeleteTopic",
        "events:PutRule",
        "events:PutTargets"
      ],
      "Resource": "*",
      "Condition": { "StringEquals": { "aws:RequestedRegion": "us-west-2" } }
    },
    {
      "Sid": "PouchSesInboundRules",
      "Effect": "Allow",
      "Action": [
        "ses:DescribeActiveReceiptRuleSet",
        "ses:CreateReceiptRule",
        "ses:UpdateReceiptRule",
        "ses:SetReceiptRulePosition",
        "ses:DeleteReceiptRule"
      ],
      "Resource": "*",
      "Condition": { "StringEquals": { "aws:RequestedRegion": "us-west-2" } }
    },
    {
      "Sid": "PouchSesInboundObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::<bucket>/inbound/*"
    },
    {
      "Sid": "PouchSesInboundList",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::<bucket>",
      "Condition": { "StringLike": { "s3:prefix": ["inbound/*"] } }
    },
    {
      "Sid": "PouchIdentity",
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    }
  ]
}
```

SES's receipt-rule actions take no resource ARN, so IAM can't hold them to one rule set; `Resource: "*"` and the region condition are as narrow as it goes. What keeps Pouch off the account's other receipt state is what the list leaves out: no creating, activating, reordering or deleting a rule set, and no receipt filters. `iam:SimulatePrincipalPolicy` is only for a conversion (below); add it back for one. `s3:ListBucket` lets a missing object read as missing rather than denied.

### Converting a legacy SES account

A legacy row is an SES `providers` row with no `shared_provider_id` that isn't `shared`. `convertToTenant` (`lib/providers/convert.ts`) makes it a tenant of a shared provider on the same AWS account and keeps its id, so its webhook URL, configuration set and topic stay put.

Stages, in order. Each is idempotent, and a rerun skips the ones already finished:

1. **parent:** reuses the `shared` row with the same `(adapter, provider_identity)`, or inserts one with the row's credentials.
2. **parent_setup:** the status topic, EventBridge rule and subscription, skipped when the parent has `topicArn` and `eventRuleArn`.
3. **tenant:** `CreateTenant` with tenant suppression. Stores `tenantArn` on the row.
4. **associate:** checks each identity's tags, then associates the row's configuration set and every identity bound or pending on it.
5. **tag:** adds `mail-tenant` to each identity.
6. **suppression:** copies the provider suppression list into the tenant's, skipping addresses already there.
7. **flip:** one `UPDATE` sets `shared_provider_id`, the parent's credentials and `settings.tenantName`. Sends claimed after it carry `TenantName`; sends before it don't.

Stages 4 to 6 record progress in `settings.conversionStep`. Before any change, the credentials' own principal is checked with `iam:SimulatePrincipalPolicy` against what the remaining stages need, and the run stops with the list of what's missing.

**Permissions** for a conversion that creates the parent: `iam:SimulatePrincipalPolicy` on the user itself, `sns:CreateTopic`, `sns:SetTopicAttributes`, `sns:Subscribe`, `events:PutRule`, `events:PutTargets`, `ses:CreateTenant`, `ses:GetTenant`, `ses:PutTenantSuppressionAttributes`, `ses:GetEmailIdentity`, `ses:CreateTenantResourceAssociation`, `ses:TagResource`, `ses:ListSuppressedDestinations`, `ses:PutSuppressedDestination` and `ses:SendEmail`. A parent that's already set up drops the SNS and EventBridge actions.

**Production run:**

1. Add `events:PutRule`, `events:PutTargets` and `iam:SimulatePrincipalPolicy` (resource: the `pouch` user's ARN) to `pouch`. AmazonSESFullAccess and AmazonSNSFullAccess cover the rest.
2. Wait for the health loop to fill in `provider_identity` on the row. The conversion refuses a row without one.
3. Test the no-gap claim with a scratch identity on the same provider: associate it with a scratch tenant, send once without `TenantName` and once with it.
4. `docker compose exec mail node --import tsx scripts/convert-provider.ts <row id> --dry-run` and read the plan.
5. Run it again without `--dry-run`. On a failure it prints the stage it stopped at; run the same command to resume.
6. Check: `GetTenant` reads `ENABLED`, a test send from `example.org` reaches `delivered`, the parent reads ready once SNS confirms, and `/healthz?detail` is green.

**Rollback**, SQL and AWS only:

1. After the flip, clear `shared_provider_id` and remove `tenantName`, `tenantArn` and `configurationSetAssociated` from settings in one `UPDATE`. Before it, remove `tenantArn` and `conversionStep`.
2. Delete the tenant, which drops its associations and suppression list.
3. Remove the `mail-tenant` tag (`UntagResource`) if the tag stage ran. An identity from before tagging otherwise reads as another provider's.

### SMTP TLS

The SMTP ingress (`mail-smtp`) needs a certificate on disk before it does anything: no `SMTP_TLS_CERT_PATH`/`SMTP_TLS_KEY_PATH` means 587 starts with `AUTH` disabled in production (`lib/smtp/tls.ts`, `lib/smtp/server.ts`). Production listens on 587 only. A self-hoster who can open 465 turns on implicit TLS by setting `SMTP_IMPLICIT_TLS_PORT` and publishing that port; it also needs the certificate. Traefik already runs an ACME resolver for the app's own hostnames, so this reuses it rather than standing up a second ACME client:

1. **DNS**: an A record for the SMTP hostname (`smtp.pouch.email` by default) pointing at the host, DNS-only, not proxied. Not managed by this repo.
2. **`SMTP_TLS_HOST`**: set to that hostname. It drives a Traefik router (`mail-smtp-cert`, on the `mail` service, same shape as `mail-alt`) that exists only so Traefik provisions and renews a certificate for it over HTTP-01 — nothing serves HTTP there. Defaults to `unset.invalid`, the same inert sentinel `APP_HOST_ALT` uses, so the rule stays valid unset. `mail-smtp` also reads it (defaulted to `smtp.pouch.email` there, matching the cert path defaults) as the SMTP greeting name — `lib/smtp/server.ts` passes it as `smtp-server`'s `name` option so 250 responses identify as the hostname instead of `smtp-server`'s own default, `os.hostname()`, which inside a container is the container id.
3. **`mail-certs`**: a `traefik-certs-dumper` sidecar that watches Traefik's `acme.json` (`TRAEFIK_ACME_JSON`, mounted read-only) and writes into the `mail-certs` volume with `--domain-subdir`, giving a deterministic `<dest>/<domain>/certificate.crt` and `<dest>/<domain>/privatekey.key` — the tool's flat mode instead splits certs and keys across separate `certs/`/`private/` subdirectories inconsistently enough that its own docs disagree on which holds what, not something worth a production deploy resting on. `mail-smtp` mounts the same volume read-only and defaults `SMTP_TLS_CERT_PATH`/`SMTP_TLS_KEY_PATH` to `/certs/smtp.pouch.email/certificate.crt` and `/certs/smtp.pouch.email/privatekey.key`. Set a different `SMTP_TLS_HOST` and both path variables need overriding to the matching `/certs/<that hostname>/...` paths.
   The dumper writes `privatekey.key` `0600` root-owned on every dump — unreadable to `mail-smtp`, which runs as uid 1001 (the `app` user, see `Dockerfile`). `mail-certs`' `--post-hook` runs `scripts/fix-smtp-key-perms.sh` after every dump (the first one included) to `chown` the key to `1001:1001` and put `0600` back, so it stays unreadable to everything except that one user rather than widening it world-readable. The hook is a single script invocation, deliberately — the dumper splits `--post-hook` on whitespace with no shell involved, so `&&` and globs don't work, and a failing hook panics the dumper process.
4. **Rotation**: `--watch` on the dumper rewrites the PEMs whenever Traefik renews (every ~60 days, at the 30-day-to-expiry mark). `mail-smtp` watches those same files (`watchTlsConfig` in `lib/smtp/tls.ts`) and pushes the new certificate into every listener via `smtp-server`'s `updateSecureContext` — no restart, no gap where it serves an expired certificate. `--watch` needs inotify headroom on the host: `fs.inotify.max_user_instances` defaults to 128 on most distros, and a busy host can already be near that before this container starts one more watcher. Set it to something with real headroom, such as 512, in `/etc/sysctl.d/99-inotify.conf`, or the dumper's `--watch` dies with `failed to create new watcher: too many open files` — a host prerequisite, not something this repo can set.
5. **Before the certificate exists**: on a fresh deploy, `mail-certs` has nothing to dump until Traefik finishes the HTTP-01 challenge for `SMTP_TLS_HOST`, which itself needs DNS and the `mail` service's router in place first — so `/certs/smtp.pouch.email/` itself doesn't exist yet either. Until then `mail-smtp` starts without TLS (587 with AUTH disabled, and no implicit TLS even when enabled) rather than crash-looping: `loadTlsConfig()` treats configured-but-missing files the same as unconfigured, and `watchTlsConfig` only ever runs once a listener has actually started with a certificate, so there's no attempt to watch a directory that isn't there. This cold-start case still needs one restart: watch `docker compose logs mail-certs` for a successful dump, then `docker compose restart mail-smtp`. After that first restart, every later renewal is picked up without one.
6. **An unreadable or malformed certificate** — wrong owner, bad permissions, a half-written file caught mid-rotation — degrades the same way a missing one does rather than crash-looping the process: `loadTlsConfig()` catches the read and validates the PEM (via `node:tls`'s `createSecureContext`), logs at error level naming the path and the reason, and returns `null` instead of throwing out of adapter init or letting `smtp-server` throw on construction. A rotation that lands an unreadable or malformed file behaves the same way — `watchTlsConfig` only swaps in a reload that came back non-null, so a bad write during rotation leaves the previously loaded certificate serving instead of tearing it down.

On Vardo (`docker-compose.vardo-production.yml`) there's no dumper. The app's cert services setting names `pouch-smtp`, and Vardo writes `/certs/smtp.pouch.email/fullchain.pem` and `privkey.pem` into a read-only volume it mounts there, readable by uid 1001. It needs `smtp.pouch.email` as a domain on the app, and it picks up renewals every 10 minutes. The cold start in step 5 still takes one restart of `pouch-smtp`.

## Rules

- Kit files are never edited here. Fixes go to uikit and come back through `pnpm uikit` (see UI kit).
- The product name comes from `lib/brand.ts`. It appears in no identifier, env var, table or route.
- Anything a recipient or an external system reads the name out of comes from `WIRE_TOKEN` in `lib/wire.ts`, never from `lib/brand.ts`. The token is frozen at `pouch` and survives a rename — see `docs/decisions.md`.
- Every tenant table has `organization_id`. Null marks a row as the install's own; install tables like settings and heartbeats have none.
- Adapters implement `Adapter` and nothing else reaches a provider SDK.
- Delivery events only. Nothing in schema or UI tracks opens or clicks.
- Errors follow `api/conventions.md` exactly. New error codes are added to the table there in the same PR.
- Migrations via `drizzle-kit generate`, applied on start.
- Message bodies and attachments go to R2, never Postgres. Events are kept indefinitely and an address can be purged on request. Each message is encrypted at rest with a per-message key, and `organizations.body_retention_days` (default 45, from 7 to the install's ceiling `body_retention_max_days`, 365 by default and 730 at most) bounds how long the key stays around, held to the ceiling. A worker shreds keys past the boundary — nulling `messages.body_key` and stamping `body_purged_at` — so the inert R2 object can't be opened. One lifecycle rule on the bucket, strictly above the ceiling, collects the remaining objects. Raising the ceiling means moving that rule first: a ceiling at or past it is refused, and the `body-lifecycle` health check degrades if the rule later drops to it. Reading the rule needs a storage token that can read bucket configuration; without one, Admin settings warns and the check reads unknown. Inbound mail is sealed the same way: text and HTML in `<storage_key>/body.json`, attachments and the raw message beside it, all under `inbound_messages.body_key`. The inbound sweep deletes the objects, nulls the body in the message's stored webhook payloads, then deletes the row and its key. A domain holds inbound mail `inbound_retention_days` (7 by default), held to the install's ceiling `inbound_retention_max_days` (30 by default, 365 at most); the sweep purges at whichever comes first. No bucket rule is needed under `inbound/`, but one at or under that ceiling is refused and degrades the `inbound-lifecycle` health check. Download links go through `/download/<token>`, which decrypts. A message's `body_bytes` and `attachment_bytes` are written at accept, since a shredded body can't be measured; every insert into `messages` sets both.
- Activity rows expire by class: `retention` and `client` on each entry in `lib/activity/taxonomy.ts`. A setup change keeps `activity_retention_days` (730 by default, 365 at least), a routine event `activity_churn_retention_days` (90 by default) and a sign-in the routine window but never under 90 days (`lib/activity/windows.ts`). The `activity-retention` loop deletes hourly (`WORKER_ACTIVITY_RETENTION_INTERVAL_MS`, `WORKER_ACTIVITY_RETENTION_BATCH`). With the worker off, nothing expires.
- Dashboard auth is Better Auth. Cloudflare Access is an optional layer in front, added later, and nothing in the app assumes it.
- Two access axes, orthogonal: `users.admin` is service-wide, `memberships.role` is `owner | member` inside one organization (`lib/auth/permissions.ts`). Every write inside an organization goes through `requireOrganizationWrite`, owner-only work through `requireOrganizationOwner` (`lib/dashboard/session.ts`). Who can do what is in `docs/decisions.md`.
- A provider `429` or quota response is a backoff on that provider, never a failed message.
- Addresses are normalized before matching: domain part lowercased, local part preserved. Suppression and unsubscribe match on the normalized form.
- Admin alerts use push (ntfy); the service never depends on itself to report that it's down.
- Email to an organization's owners is a type in `lib/notifications/registry.ts`, sent through `sendNotification`, with an admin switch in `lib/settings/registry.ts`. See `docs/decisions.md`, "Owners are emailed by default, and each type is silenced on its own".
- An install-wide setting an admin changes is an entry in `lib/settings/registry.ts`, read through `readSetting`, which is the only resolver: env, then `pouch.yml`, then `service_settings`, then the default. An optional feature is a boolean entry, checked once at each boundary: its API paths in `lib/features/registry.ts`, `feature` on a worker loop, a `layout.tsx` on its screens. See `docs/decisions.md`, "Optional features are flags an admin turns off, and the core has none".
- A worker loop records every run in `job_heartbeats` (`lib/health/jobs.ts`); new loops get this by extending `IntervalLoop` (`lib/worker/interval-loop.ts`) and joining `LOOP_NAMES`. A loop that waits on someone else per item drains through `rollingPass` (`lib/worker/rolling.ts`). A loop that's stale, failing or never run degrades `/healthz?detail` through the `jobs` check.
- A health check changing state pushes once (`lib/health/watch.ts`, run by the worker's `health-watch` loop): on the second failing pass in a row, once recovered, nothing between. The `worker` check is left out, since the watcher is a worker. A worker that's down can't say so; an external monitor on `/healthz` covers that.
- No package-manager wrapper in a service's signal path. `pnpm` exits on SIGTERM without passing it on, so production commands start `node` directly under tini (`scripts/start.sh` for the app).
- Database backups are the host's job, not the app's.
- A capability is defined once in `lib/<resource>/`, with its own validation and authorization. The route, the MCP tool and the dashboard action are thin adapters over it. `lib/dashboard/` holds only what a screen needs — its loader and, in `views/`, the shapes it renders. A capability a second surface calls moves out to the resource (`docs/decisions.md`). Nothing in `app/` but a route handler imports `@/lib/db` (`@/lib/db/clock` and `@/lib/db/enums` are allowed: a timestamp and constants, not data access); a lint rule enforces it.
- The API is the default surface. Every exported `*Action` and every handler under `app/api/dashboard/` names a route in `lib/api-docs/spec.ts` or records why the dashboard is its only one, in `lib/api-docs/surfaces.ts`. `pnpm check:docs` fails on one in neither, so a new capability can't merge without that decision. The dashboard-only entries are the decision record; each reason says why, and one that reads as a to-do belongs in an issue instead.
- The SDK publishes to npm as `@joeyyax/pouch` with `pnpm release:sdk`, a local script since there's no CI. It refuses off `main`, on a dirty or stale tree or on a version npm already has, then runs the SDK tests, builds ESM, CJS and types into `sdk/dist` and publishes as the `npm login` account, which asks for 2FA. npm is retiring publish tokens that skip 2FA, so none is kept; With a passkey it opens npm's approval page and publishes once approved; `--otp=<code>` passes an authenticator code instead. npm holds a new version for a few minutes behind a `0.0.0-stage` placeholder before it's installable. `NPM_TOKEN` still works when set. `--dry-run` stops before the upload.
- Every route in `lib/api-docs/spec.ts` has a method in `sdk/pouch.ts` or a reason in `NO_SDK` (`tests/unit/sdk-coverage.test.ts`). The check drives the client with a stub `fetch` and compares the paths it calls, so a renamed route fails rather than drifting.
- A test never changes the schema outside `withSchema` (`tests/integration/migration-replay.ts`), which applies the DDL inside a transaction that always rolls back. Dropping a constraint and putting it back in `finally` leaves the database wrong for every later run in that checkout when the body throws. A lint rule enforces it.
- A timestamp the database will compare against another comes from `dbNow()` (`lib/db/clock.ts`), read once per operation. `next_attempt_at`, `backoff_until`, `locked_at`, `last_checked_at`, `sent_at` — never `new Date()`. Mixing the app's clock with Postgres `now()` makes what's due depend on the skew between two machines. Tests that write their own due timestamps follow the same rule, and `TEST_CLOCK_SKEW_MS=2000 pnpm exec vitest run` proves the suite doesn't care about the offset.
- Every request runs inside `runWithRequestId`, so `X-Request-Id` prefixes every log line it causes. `withApiKey` does it for `/v1`; `withRequestId` (`lib/api/request-context.ts`) does it for webhook, inbound and dashboard routes. A send stores the id on `messages.request_id` and the worker rebinds it, so accept and delivery lines carry the same id.
- An error reaching a log line or a stored reason goes through `safeErrorMessage` (`lib/errors/scrub.ts`). A driver error's message and `detail` carry the query, its parameters and the offending row — recipient addresses, in other words.
- A browser render error reaches GlitchTip through `POST /client-errors` (`lib/errors/client-ingest.ts`), sent by `reportClientError` from `app/(app)/error.tsx` and `app/global-error.tsx`. It sends a route, a digest or a message, and nothing else. The server rate-limits per hashed address (10 a minute), caps the body at 2 KiB, validates strictly and scrubs through `reportError`. With no `GLITCHTIP_DSN` it answers 204 and does nothing. It's an internal route, not an API surface: it sits outside `app/api/dashboard/`, so `lib/api-docs/surfaces.ts` doesn't list it.
