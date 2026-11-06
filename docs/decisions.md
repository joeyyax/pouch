# Decisions

Choices that shaped the service, and what would change them. Read this before undoing one.

Each entry says what was decided and why. Where a decision is enforced by code, the file is named — that's where it'll break if someone changes it without reading this.

A superseded decision is rewritten, not left standing beside its replacement. Where the old wording is worth keeping — someone will wonder why it changed — it says **Superseded by** and names the entry that replaced it.

## A domain binds to one provider

A domain sends through exactly one provider. Not many.

**Why:** DNS is the constraint, not the code. A name gets one SPF record and SPF allows 10 lookups, and every provider spends one — the domain screen already warns about this. Providers also each want their own MAIL FROM subdomain, and two wanting `mail.<domain>` collide. Beyond DNS, provider-side suppression doesn't federate: a hard bounce SES knows about is invisible to Mailpace, so splitting a domain across two means each learns half the bad addresses.

**The exceptions, both deliberate:** a move to another provider holds a second, pending binding until it verifies (see below), and failover — when it's built — is a pool with one primary and an ordered fallback, not a free choice per send. A pool keeps the routing rule fixed, which is what stops this becoming a caller-facing decision.

**Revisit when** failover or per-class routing (bulk through a cheaper provider) is actually wanted. Not before — a general many-to-many buys nothing DNS can support.

## A domain moves by staged cutover, never an immediate rebind

`PATCH /v1/domains/:id` records a pending binding. The domain keeps sending on its current provider until the new one verifies, then cuts over on its own. Cancelable throughout.

**Why:** an immediate swap is only safe on a domain with no traffic. The production Mailpace-to-SES cutover got away with it because there was one domain, one message and no load; the next one won't. Reversibility is what makes the operation affordable to run on a domain that's actually sending.

In flight sends need no special handling: `messages.provider_id` is written at send and events route on it, so a message sent through the old provider resolves its events there after the cutover.

## The queue pauses, it doesn't refuse at the door

When a domain's bounce or complaint rate climbs toward the level that gets a provider flagged, the guard stops *releasing* queued messages. It doesn't reject the send.

**Why:** messages are already accepted and paced by the worker, so pausing loses nothing and is reversible. That's what lets the guard act early. A guard that can only refuse has to be cautious to be safe, and caution is the wrong posture when the downside is the provider suspending the account.

## A suspension refuses at the door; only a manual suspension fails the queue

Suspending an organization refuses new sends with `organization_suspended`, whatever the source. Queued mail fails only when an admin suspended it. Under a `reputation` or `provider` suspension it waits and sends on release (`holdsQueue`, `lib/suspension/sources.ts`).

**Changed 2026-09-17 (#355, increment 8):** a `provider` suspension used to fail queued mail too. It holds now.

**Why:** a person stopping an organization means the queued mail shouldn't go out later. The org-level pause and a provider pause aren't that judgment: the org-level pause is an automatic guard, and a provider pause follows the provider's policy and lifts when the provider re-enables sending. Failing the queue there loses mail over a pause that may end on its own. Refusing new sends is still right under every source, since a caller learning at once beats piling into a queue nobody is releasing.

**Held mail doesn't expire.** A long pause sends old mail when it lifts, so the overview shows the oldest held message's age.

**Why the org-level pause skips domains the domain pause covers:** with one domain, the summed counts are the domain's counts, so every domain pause would also suspend the organization and turn a held queue into refused sends.

**Revisit when** an admin wants to fail a held queue without releasing it, or a provider pause lasts more than a day.

## A provider is the email service; an account is a person's

The rows holding one email service's credentials are `providers` (#375). An account is a person's account. Domains belong to organizations. "Tenant" is SES's word for how one SES account isolates senders, and Mailpace has no equivalent, so it stays inside `lib/providers/adapters/ses/` and the settings keys that name real SES resources (`tenantName`, `tenantArn`, `tenantState`). Everything a user reads says what happens instead: a provider is shared, and each organization is isolated on it. `kind` is `shared | single`, matching the `shared` column.

**Ids keep the `pac_` prefix.** They aren't only ours: SES identities are tagged with the provider id, and each provider's registered webhook URL ends in it. Rewriting them would mean re-tagging identities and re-registering subscriptions at the provider, and rewriting an append-only activity log that names them. Ids are opaque, so the prefix costs nothing to leave.

**Revisit when** a provider id stops being an external reference — no tag, no registered URL carrying it. Then a rename is a pure SQL migration.

## Each organization is assigned one provider

`organizations.provider_id` names the provider an organization's new domains bind to. An admin assigns it, and `ASSIGNMENT_LIMIT` (`lib/providers/assignment.ts`) allows one, plus a second only while a move is in progress. A new organization gets the provider an admin marked default for new organizations (`onboard_new`), or nothing; with nothing, `POST /v1/domains` returns `provider_unassigned`.

**Why one:** a hosted organization has no reason to pick a provider, and the domain picker only earns its place with a real choice.

**Revisit when** an organization needs two providers at once. The schema already allows it: lift the limit and show the picker, with no migration.

## An organization is isolated at the provider when the provider can be shared

A tenant-capable provider (SES) is a `providers` row with `shared` set and no organization. Each assigned organization gets its own row with `shared_provider_id` pointing at it, a copy of the encrypted credentials and the tenant's name in `settings`. An adapter without tenants (Mailpace, Cloudflare) serves one organization, and its row lives in that organization.

**Why the tenant row, not the shared row, holds per-organization state:** configuration set, topic, backoff, concurrency and health are per organization, and `domains_provider_fk` is composite on `(organization_id, provider_id)`, which is what stops a domain binding another organization's provider. Domains bind to tenant rows, never to the shared row, so that guard holds with the shared row's organization null (#374).

**Why copy the credentials:** `adapterFor` stays synchronous and every send path stays as it is. The copy is read inside the insert (`onboardOrganization`, `lib/providers/shared.ts`), and rotation rewrites the shared row and every copy in one `UPDATE`, so they can't drift. Shared rows are filtered out of every organization-facing list and lookup.

**Every tenant runs SES's default reputation policy**, the one `CreateTenant` applies when none is named, with tenant-scoped suppression.

**Revisit when** #264 lands a single descriptor per adapter, or a second adapter gains `capabilities.tenants`.

## An organization's space at the provider is created with its first domain

Assigning a tenant-capable provider inserts the tenant row and calls nothing. The first domain on that row creates the SES tenant, its configuration set and its topic (`lib/domains/index.ts`, `createDomain`). The health sample skips tenant rows with no `tenantArn`, and an assignment with no domains reads `ready`.

**Why:** an organization with no domains costs nothing: no SES tenant charge, no call against the 1/s API budget and no slot in the 10,000 configuration-set cap (#320).

**The cost:** the first domain on a provider takes about nine seconds longer. Setup that stops part way is retried by the verify loop.

## One AWS account or two is the admin's choice

The admin's organization and customer organizations can all be tenants on one SES account, or customers can get a separate one. Both work: a provider is added in Admin settings → Providers and assigned to whichever organizations should share it (`scripts/bootstrap-provider.ts`). Pouch's own mail rides whichever provider owns the system from address's domain.

**Why it's not a rule:** tenants already isolate reputation and suppression. What one provider can't isolate is an account-level pause from AWS, which stops every tenant on it, Pouch's password reset included.

**Revisit when** customer volume makes an account-level review likely.

## Public signups stay off until per-organization caps exist

`disableSignUp: true` (`lib/auth/index.ts`) stays until #292 caps domains and send volume per organization.

**Why domains and volume, not organizations:** an empty organization creates no tenant and makes no AWS call. A domain creates a tenant, a configuration set and a topic, and sending spends the provider's quota and reputation.

**The cap has to count domains per user too.** By default any signed-in user can create organizations (`organization_creation`), so a cap per organization alone lets one user add a domain in each.

**Revisit when** the #292 caps ship.

## A throttle on a shared provider holds every organization on it

SES rate limits apply to the AWS account, not the tenant. A throttle on any tenant row writes `backoff_until` to the shared provider, and the claim query joins it, so every tenant waits (`lib/messages/queue.ts`, `worker/send.ts`). One row is written, never the thousands of tenant rows. The write never shortens a longer backoff. The API reports a tenant's effective backoff (`withSharedBackoff`).

**Only provider-scoped errors.** A provider marks a backoff `accountWide`, and SES does it for throttles (`ThrottlingException`, `TooManyRequestsException`, 429, or SES's "Maximum sending rate exceeded" and "Daily message quota exceeded" messages under any name) and for rejected credentials, since every tenant holds a copy of them. A pause stays on the tenant that hit it: SES doesn't document what a paused tenant's send returns, and treating a tenant pause as provider-wide would stop every organization for 15 minutes. EventBridge already suspends a paused tenant's organization.

**Revisit when** SES documents the error for a paused tenant.

## An SES send error holds only what it's about

`lib/providers/adapters/ses/sending.ts` maps each `SendEmail` error to the narrowest effect that covers it:

| Error | Effect |
|---|---|
| "Daily message quota exceeded" | Backs off the provider, and a shared provider's tenants, for 10 minutes |
| Any other throttle or quota message | Backs off the provider, and a shared provider's tenants, for 60 s |
| Rejected credentials | Backs off the provider, and a shared provider's tenants, for 15 minutes |
| `SendingPausedException`, `ProviderSuspendedException` | Backs off the row that sent for 15 minutes |
| `MailFromDomainNotVerifiedException` | Fails the message |
| `LimitExceededException` | Fails the message |
| 5xx, 408, network error | Retries the message |
| `NotFoundException`, and SES no longer has the tenant or configuration set | Backs off the row for 5 minutes and rebuilds the resource |
| `AccessDeniedException`, `MessageRejected`, any other `NotFoundException`, other 4xx | Fails the message |

**`LimitExceededException` fails the message.** SESv2 documents it as "There are too many instances of the specified resource type" (HTTP 400), not a rate. Sending limits arrive as `ThrottlingException` with a quota message, and that message still backs off whatever the error's name.

**An unverified MAIL FROM fails the message, not the domain.** SES raises it only when the identity's `BehaviorOnMxFailure` is `REJECT_MESSAGE`. Pouch creates identities with `USE_DEFAULT_VALUE`, so SES falls back to `amazonses.com` instead, and the error means someone set the identity to reject in the console. Failing the message does what that setting asks. The domain pause doesn't fit: it's a reputation guard that only a person releases, it alerts as a reputation pause, and nothing would release it when the records verify. The domain stays verified, since verification keys off DKIM, and its DNS screen already lists the MAIL FROM records it's missing.

**Access denied fails the message.** A sending authorization policy can deny one identity, so it isn't provider-scoped.

**The daily quota waits 10 minutes, not until a reset.** SES counts the quota over a rolling 24 hours, so there's no reset time to wait for ([sending limits](https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html)). SES says to wait "up to 10 minutes" after either quota message ([quota errors](https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas-errors.html)). The per-second rate recovers within a second, so it keeps 60 s.

**A `NotFoundException` checks what's gone.** SES documents it only as "The resource you attempted to access doesn't exist," so the send reads the tenant with `GetTenant`, then the configuration set with `GetConfigurationSet`, both paced. If either is gone:
- `lib/domains/rebuild.ts` sets `rebuild` in the provider's settings. That makes `isConfigured` false, so `configureEvents` runs again. A lost tenant also clears `tenantArn`, since setup reuses a stored ARN.
- The row backs off for 5 minutes, and setup runs inline. A new tenant gets the provider's domain identities attached again.
- The first send to find the loss records a failed health verdict and sends a push alert. Later sends don't alert again.
- A failed rebuild keeps the mark, and the next held send tries again until the message's 24 hours run out. No loop is needed: only sends use these resources, so a send is always what finds the loss.

If both resources exist, the message fails. If the check itself fails, the message retries.

**Revisit when** SES documents a tenant-scoped error, or Pouch creates identities that reject on MX failure.

## Claims share a send rate in Redis

Workers claim messages against a token bucket per provider, sized from `GetAccount`'s `MaxSendRate` (`lib/providers/send-rate.ts`). Every row draws on one per provider identity, so a shared provider, its tenants and an ordinary row on one AWS account share it. Until the identity is known, a tenant uses its shared provider's id and any other row its own (`sendRateSubject`). It refills at 80% of that rate, and a burst holds 125 ms of it, so no one-second window claims more than 90% of the limit and the rest absorbs latency between claim and send. A limited round retries when the bucket says the next permit is due. Unused permits are refunded. With no known rate, or no Redis, claims aren't limited and the backoff above is the backstop.

**Why:** per-row `concurrency` counts sends in flight per worker, not sends per second, and it multiplies by every tenant and every worker. Once a throttle holds every tenant, going over the rate costs every organization a minute. Workers are separate processes, so the count has to live in Redis. The bucket runs on Redis's clock, for the same reason as "One clock" in this file.

**Ordinary providers are limited too.** The worker claims again as soon as a send finishes (#321), so the poll no longer caps their rate. A throttle there still backs off only that row.

## SES's non-send calls share one pacer per AWS account

SES throttles every API action except sending at one request per second, and the quota can't be raised ([SES quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html)). Verification polling, tenant status reads, domain setup and teardown, health probes, quota reads and the findings sweep all draw on it. Every one of those calls in `lib/providers/adapters/ses/` waits for a permit from a Redis token bucket (`lib/providers/send-rate.ts`, `api-rate:bucket:<subject>`), the same Lua bucket the send rate uses at a fixed rate.

- **One bucket per AWS account.** The subject is `ses:<provider_identity>`, so an ordinary row, a shared provider and its tenants on one AWS account share it. Until the identity is known, it's the access key, which tenants share with their shared provider. SES counts the quota per region too, so two regions on one AWS account wait on each other more than they need to.
- **`API_RATE_HEADROOM` (0.8), no burst.** A permit is due every 1.25 s, so latency between permit and request can't put two calls in one second.
- **Retries draw permits too.** The paced client turns off the SDK's own retries. A throttle or 5xx is retried up to `API_RETRY.attempts` (4) times from 1 s, doubling with jitter. A caller that waits more than `API_RETRY.maxWaitMs` (10 s) for a permit gets a throttle.
- **A throttled probe says nothing about the provider.** `healthCheck` returns `throttled`, and `recordProviderProbe` leaves the last verdict in place.
- **Sends aren't paced here.** `SendEmail` has its own quota and its own bucket (see "Claims share a send rate in Redis"). CloudWatch, SNS, STS and EventBridge have their own quotas too.
- **Without Redis, nothing is paced.** The health loop's `PROBE_SPACING_MS` still spaces probes.

The probe loop keeps its 2 s spacing on top of this, so probes take half the budget and domain setup and status reads get the rest. A tenant's domain setup makes about seven calls, so it takes about nine seconds.

**Revisit when** the permit wait shows up in request latency, which would call for a queue with priorities instead of a shared bucket.

## A shared provider's health is a rotating sample; EventBridge carries status

SES throttles every API action except sending at one request per second per provider, and that quota can't be raised. A health check that calls `GetTenant` for every organization every 5 minutes can't finish once there are more than a few hundred tenants, and it spends the budget that status reads and domain setup need.

The probe loop (`worker/health-check.ts`):

- Runs up to `PROBE_CONCURRENCY` (4) providers at once. Rows with the same `provider_identity` form one group and never run in parallel.
- Leaves `PROBE_SPACING_MS` (2 s) between calls to one provider, which keeps probes to half of SES's quota. The pacer above is the hard ceiling.
- Probes `TENANT_PROBES_PER_PASS` (60) tenants per shared provider per pass, in id order from a cursor in Redis, then wraps. That's 2 minutes of a 5-minute interval. A full rotation takes about 1.4 hours at 1,000 tenants and 14 at 10,000 (SES's default tenant quota).
- Lets one replica per interval sweep a shared provider.
- Keeps a tenant's health record for `TENANT_CHECK_TTL_SECONDS` (24 hours), longer than a full rotation, so a tenant between probes doesn't read "not checked."

**Why the sample is enough:** status changes arrive through EventBridge within seconds. The sample catches an event that was lost. It doesn't need to detect changes itself.

**Revisit when** a shared provider passes about 17,000 tenants (288 passes a day at 60 each), where a rotation outlasts the record's TTL. SES caps configuration sets at 10,000 per provider, and Pouch creates one per tenant, so one provider can't reach that anyway.

## An SES identity belongs to the provider that tagged it

Every identity Pouch creates carries its owner's tag: `mail-tenant` with the tenant name on a shared provider, `mail-account` with the provider id otherwise. When SES says the identity already exists, the create continues only if the tag names the same owner; anything else is `domain_unavailable`.

**Why:** identities are provider-wide. Without this, a second organization adding a domain another one already verified would read the existing DKIM tokens and send as that domain without touching DNS. An untagged identity is refused too, since nothing says whose it is.

**Identities from before tagging:** they stay untagged and keep sending, since only create and remove read the tag. Remove deletes an untagged identity on an ordinary provider, because it's only called for a row bound to that provider. No backfill: tagging on verify would let whichever of two legacy bindings checked first claim the identity, and a refused create is already the safe outcome for everyone else.

**An admin can adopt an untagged one (#366).** `POST /v1/admin/domains` tags an untagged identity for an organization's tenant, attaches it and keeps its DKIM, so a self-managed SES setup moves onto Pouch without the domain going dark while new records verify. `lib/providers/adapters/ses/domains.ts`'s `domain.adopt` never calls `CreateEmailIdentity` and never rotates a signing key; it sets the MAIL FROM domain only when the identity has none, so an envelope configuration someone else made is untouched. The credentials that read the identity are the assigned provider's own, which is what proves it's that AWS account's identity.

**Why admin-only:** the refused create is still the safe outcome for an organization, which can't be trusted to say an identity is its own — claiming a domain by name is exactly what the tag exists to stop. An admin already holds the provider's credentials and decides which organization it serves. Organization keys and organization screens keep getting `domain_unavailable`, with no adopt affordance.

**An identity tagged for someone else stays refused,** admin or not. Adoption widens "untagged" to adoptable; it never overrides an owner.

**Revisit when** no untagged identities remain. Production had eight when this shipped.

## A domain stays until the provider lets go of it

`DELETE /v1/domains/:id` fails with `provider_unavailable` and keeps the row when the provider delete fails. An identity the provider no longer has counts as removed. A pending move's identity is dropped first, under the same rule; the verify loop retries an expired move's on its next pass.

**Why not record an orphan for the worker:** the row is already the record, and the caller can retry. An orphans table and a loop would carry state for a rare failure that a retry covers.

**The row goes first, inside the transaction the provider call runs in (#389).** `lists.domain_id` and `batches.domain_id` are `onDelete: "restrict"`, so a check ahead of the provider call is a check, not a guarantee — a list created in between left the identity gone and the row behind, a domain that looks fine and can never send. Deleting the row first makes the foreign keys what decides, and the provider call inside the same transaction means a provider failure rolls the delete back. `domainDeleteBlock` (`lib/domains/deletable.ts`) still runs first, for a refusal that names what's blocking it, and the dashboard reads the same function to disable the button and link the lists.

**What the transaction costs:** it's held across a provider call, which the repo does nowhere else. The SES path is bounded — `SEND_TIMEOUT_MS` (60 s) per request, four attempts, a 10 s permit wait each — so worst case is a few minutes holding one domain row's lock, and what it blocks is a list insert naming that domain. That's the behavior wanted here. A provider without a request timeout would make it unbounded, so give every adapter one.

**Why not commit first, then call the provider:** a provider failure would then leave an identity nothing points at. Identities are tagged with their owner, so nobody could re-add the domain and only an admin could adopt it back. The row surviving a provider failure is recoverable; an orphaned identity isn't.

## Sending status reaches Pouch through SNS, and the provider's current status decides

An EventBridge rule on the shared provider targets an SNS topic subscribed to that provider's existing webhook route, so status events use the same signature and topic checks as delivery events. Each event triggers a `GetTenant`; a pause suspends only if the tenant isn't enabled, and a release happens only if it is.

**Why:** SNS delivers at least once and out of order. Reading the current status means a delayed `Disabled` can't suspend a tenant SES already reinstated, and a replayed `Enabled` can't release a tenant that's paused again. An API destination would have needed a second verification scheme.

**A failed read asks for redelivery.** When `GetTenant` fails or stays throttled, the webhook answers 503 and changes nothing. SNS retries 5xx and 429 and drops anything else ([delivery retries](https://docs.aws.amazon.com/sns/latest/dg/sns-message-delivery-retries.html)). Its default HTTP policy retries 3 times, 20 s apart, so a read that fails past that drops the event. A missed pause is the safer miss: SES has already stopped the tenant's sends. A tenant SES no longer has still suspends.

## The provider lifts only its own suspension

`Sending Status Enabled` calls `releaseOrganizationSuspension` with `onlySource: "provider"`. A manual or reputation suspension stays until a person releases it. This is the one release that doesn't come from a person.

## A reputation finding is recorded, not acted on

`Advisor Recommendation Status Open` writes `provider.finding.opened` to the organization's activity and pushes an alert when SES rates it high impact. It doesn't suspend.

**Why:** the standard reputation policy already pauses a tenant on high-severity findings, and that pause arrives as `Sending Status Disabled`. Suspending on every finding would be a stricter policy than the one SES applies, chosen by accident.

**Revisit when** an admin wants strict enforcement, which belongs on the tenant's reputation policy rather than here.

## Credentials are verified before they're stored, and we say when they weren't

A create or a credential rotation calls the provider first. Credentials that fail are refused and the stored ones are untouched.

**Why:** a rotation that stores a broken key leaves the provider failing on its next send, which is the worst time to find out.

**The honest part:** not every adapter can check. Mailpace's per-domain server token has no read-only endpoint, so a write against a provider with no organization token goes in unverified. The response says so — `credentials_verified` is `true`, or `null` meaning nothing checked it. A green tick over a check that didn't happen would be worse than no check at all.

The scheduled probe carries the same honesty: an adapter that can't check itself records `ok: null`, not silence, so "can't check" reads differently from "never checked" (`lib/health/checks.ts`). If a provider was checkable and no longer is, the next probe overwrites its last true/false verdict with null rather than keeping a stale one — an old green tick is worse than an honest unknown.

## A provider's identity comes from the provider, never a guess

`providers.provider_identity` holds the provider's own identifier for the account behind a row's credentials — an AWS account id, for SES — and is asked for through the provider's API, on the same periodic loop that already probes credential health (`worker/health-check.ts`). Nullable, and null means exactly one thing: nothing has answered yet, never a stand-in for "same as no other row."

**Why not a hash of the stored credentials:** rotating a key would read as a brand-new provider, which is the opposite of what this column exists to survive, and two rows expressing the same credentials in a different shape (whitespace, casing) wouldn't match even though the provider behind them does.

**Why not an admin-supplied label:** honest about being a guess, but a typo or a copy-pasted label makes two different AWS accounts look like one — worse than the gap this closes, since it reads as confidence that isn't earned.

**Why the provider's API:** SES's `GetCallerIdentity` (STS, not SES itself — SES's own `GetAccount` doesn't carry a provider id) survives credential rotation and needs no extra IAM grant beyond what sending already requires. `lib/providers/adapters/ses/account.ts` implements `Adapter.identity()`; Mailpace doesn't; per the type, an absent `identity()` reads as "this adapter has no such concept," never as null.

**Two organizations, one AWS account:** grouping is by `(adapter, provider_identity)`, not by `providers.organization_id` — see `lib/system/read.ts`. A row with no known identity groups alone, keyed by its own provider id, so it's never merged with another unidentified row: two unknowns aren't known to be the same provider.

**Existing rows:** the periodic probe (`WORKER_HEALTH_CHECK_INTERVAL_MS`, 5 minutes by default, and it runs once immediately on worker boot) fetches and stores the identity for every provider whose adapter can answer, so every existing SES row backfills on its own within one interval of this shipping — no migration script needed. A Mailpace row never gets one; it shows as "unknown identity" on the admin view, permanently, which is the honest state rather than a fabricated one.

**Revisit when** an adapter besides SES needs the same treatment — the shape (`Adapter.identity()`, optional, `string | null`) already generalizes; only the implementation is provider-specific.

## Providers are managed by admins, in the dashboard and the admin API

Sending is provider-blind: `POST /v1/emails` names a domain, never a provider. Admins create, rotate, assign and delete every provider, from Admin settings and from `/v1/admin/*` with an admin key (`docs/api/admin.md`). Organization keys only read: `GET /v1/providers` returns `assigned` and `status`, never `settings` or credentials, and every write method answers `405` (`app/api/v1/providers/`).

**Why:** on the hosted version the credentials and the AWS account behind them are the admin's. A tenant's `settings` hold ARNs that name that provider, and an organization key could spend the shared provider's 1/s API budget through the old test route. Writes live in `lib/providers/admin.ts` and `lib/providers/assignment.ts`.

**Credentials are write-only for everyone,** admins included. No route, action, tool or screen returns them.

**Revisit when** hosted organizations bring their own provider, which needs a safe credential handoff first (#292).

## The fast poll's status code stays untouchable by a third party

`GET /healthz` checks Postgres and nothing else, so a dependency outage at a third party can never move its status code. `GET /healthz?detail` reaches every dependency — Postgres, Redis, storage, queue, worker, providers — and answers 503 when one is down.

**Why:** the container healthcheck polls bare `/healthz` every few seconds. If that call reached the other dependencies, an outage at a third party would start restarting containers that are otherwise fine, turning someone else's incident into ours. The rule protects the status code of the fast poll, not how many routes exist — depth lives behind `?detail` instead.

`?detail` is unauthenticated, so its body carries only what a monitor needs to page on: a category of what's wrong per check, `providers: {total, down}` and a worker count. Never a provider id, a provider adapter name, a queue depth, a worker id an outsider could read operational volume from, or a thrown error's message, which names hosts and buckets. A provider with no domains bound doesn't count toward readiness: nothing sends through it, so it can't make the service unready.

## Defaults follow convention; our preferences are settings

Where Pouch differs from the industry, it differs as a setting with a conventional default.

**Why:** we'd picked a one-year body retention on our own preference and written it into the docs as though it were the product's answer. Postmark keeps content 45 days, Mailgun 3 to 30. So the default is 45 days, the range is 7 to the install's ceiling (365 unless the admin changes it), and our own organization sets a year. That's a tenant choice, not a product opinion.

The same test applies to rate limits, attachment ceilings, recipient counts and backoff windows.

## Bodies are crypto-shredded, not deleted

Each body is encrypted with its own key. Retention drops the key; a long bucket lifecycle rule collects the inert objects later.

**Why:** dropping a key makes a body unreadable immediately and verifiably, including in backups and replicas. Enforcement becomes a column write instead of a distributed delete. It also buys back the exposure of keeping content roughly ten times longer than the industry does — encrypt, or keep less; doing neither was the only bad option.

## Delivery events only. No open or click tracking

A message is queued, sent, delivered, deferred, bounced, complained or failed, and the dashboard says why. No pixels, no rewritten links.

**Why:** delivery state comes from the receiving server and is a fact about the mail. Opens and clicks come from watching the recipient. This is a product principle, not a v1 omission — it stays out when bulk arrives.

## A legacy SES row converts in place

An SES row with no `shared_provider_id` that isn't `shared` becomes a tenant of a shared provider on the same AWS account, keeping its id (`convertToTenant`, `lib/providers/convert.ts`). It runs from `scripts/convert-provider.ts`, with a dry run, and resumes where a failed run stopped. The runbook is in `docs/engineering.md`, "Converting a legacy SES account".

**Why in place:** the webhook URL, the `mail-account` tag, the configuration set name and the SNS topic all come from the row's id. A new row would mean new resources and a new verification for every domain.

**Why copy the suppression list:** a tenant with `TENANT` scope skips the provider list at send time, so an address suppressed only there would get mail again.

**Revisit when** no legacy rows remain. The conversion can go then.

## Admin is service-wide; an organization has owners and members

Two axes, orthogonal. **Admin** is `users.admin`, a service-wide flag: access to Pouch's own admin surface and system settings. It administers every organization from there and carries no membership, so it reaches inside one only by emulating it (see below). **Role** is `memberships.role` — `owner` or `member` — and decides what someone does inside one organization. The same person is an admin and a member of one organization and an owner of another; neither axis reads the other (`lib/auth/permissions.ts`, `lib/auth/admin.ts`).

| | Owner | Member |
|---|---|---|
| Read everything the organization holds | yes | yes |
| Day-to-day sending work: domains, DNS records, layouts, verification, API keys, webhook endpoints, lists, suppressions, test sends, exports | yes | yes |
| Organization settings, including body retention | yes | no |
| People: invite, change a role, remove someone | yes | no |
| Delete the organization | yes | no |

**Why owner-only is people and organization-wide settings, not sending.** A member is hired to send mail, and every part of that — adding the domain, minting the key it sends with, wiring the webhook that hears back — is the job. What an owner keeps is the shape of the organization: who's in it, how long bodies are readable, whether it exists. That line is stable as the product grows, because billing and seats land on the same side of it.

**No read-only role.** A `viewer` was specified and built, then dropped before merge: nobody had asked for one, and an organization-scoped API key carries no person, so read-only could only ever have been a dashboard promise in a product whose API is the point. A key with its own read-only scope is the honest version of that feature, and it's a different one.

**Writes are still named, and the guard stays.** Every write inside an organization goes through `requireOrganizationWrite` (`lib/dashboard/session.ts`); owner-only work goes through `requireOrganizationOwner`. Both throw one error, `insufficient_role`, in `docs/api/conventions.md`. Only the owner check refuses a role a session can carry — both roles pass the write check — so `requireOrganizationWrite` earns its place as the inventory of write paths and the single place a read-only role would plug in, not as a live gate. `canWriteInOrganization` still refuses a role outside the enum, which is what keeps a hand-edited or retired value from defaulting open.

Downloading an export counts as a write: past `lib/exports/limits.ts`'s ceiling it queues a worker job and leaves an artifact in storage. So does verifying a domain, which records the provider's answer on the row, and a test send, which sends real mail.

**The API and MCP enforce no role.** Both authenticate with an organization-scoped API key (`lib/api/with-key.ts`); MCP calls the same routes through `lib/mcp/invoke.ts`. A key records who minted it, not who is using it, so a request carries the organization's authority and no person's. Nothing tries to bridge that.

**Existing rows:** org-level `admin` was a lesser owner with the same powers on every guarded action, so it became `owner`. A role the code doesn't recognize stops the migration rather than being coerced (`drizzle/0054_roles.sql`).

**Revisit when** a key needs its own read-only scope, or a role needs to be organization-defined rather than one of two.

## An admin emulates an organization deliberately, and it expires

The organization switcher lists what you're a member of, admin or not (`listReachableOrganizations`, `lib/dashboard/session.ts`). Administering every organization happens in Admin settings → Organizations. Getting *inside* one you don't belong to is a third thing: an admin presses Emulate there, confirms what it means, and lands in that organization with a banner naming it and the way out in it. Emulation ends when they leave it, when they switch into one of their own, or on its own after 30 minutes.

**Changed 2026-09-18 (#380):** an admin's switcher used to list every organization in the install, and choosing one put them in it with no membership and an "Acting as" chip. Acting in someone else's organization was one mis-click away, and the same list mixed their own two organizations in with two hundred strangers'.

**Why a separate cookie, not the active-organization one:** `pouch_emulation` carries an organization id and an expiry, and `pouch_active_organization` carries a membership choice. Keeping them apart is what makes "am I emulating?" a fact rather than an inference, and it's why a stale emulation cookie can't quietly become a persisted choice. Neither is signed: a ticket is honored only for a user whose `admin` flag is set in the database, checked on every request that carries one, so forging one gets a non-admin nothing and gets an admin what the button already gives them.

**Why 30 minutes:** long enough to reproduce what a customer is reporting and read the screens around it, short enough that a tab left open overnight isn't still holding someone else's data open in the morning. The expiry rides in the ticket, so it holds against a cleared server memory, and re-entering is one button.

**Why every write says who really did it.** An emulated session's activity rows are written with actor type `admin` (`sessionActor`, `lib/dashboard/session.ts`), which renders as "Name (Pouch admin)" with a shield rather than as a member. Entering and leaving are rows of their own, in the emulated organization's feed, so the customer's own activity is where they find out an admin was in there. Expiry writes no row: nothing runs when a cookie lapses, so the "started" row carries the expiry it was entered with instead of a later row claiming a moment nobody was present for.

**What an admin sees while emulating:** the organization as an owner sees it. Support reproduces a report, and half a screen doesn't reproduce anything.

**An admin with no membership has no acting organization at all.** They get the frame and the admin screens, not a stand-in organization someone else owns (`requireChromeSession`). Creating an organization or emulating one is how they get further.

**Revisit when** emulation needs to be read-only, or when support wants longer than 30 minutes often enough to say so.

## Removing a suppression is member work

Adding and removing a suppression are both member work (`app/(app)/suppressions/actions.ts`).

**Superseded by** this entry: #89 made removing one owner-level, on the reasoning that sending to a bounced or complained address again risks the domain's reputation, and that a member shouldn't hold account-level damage. #376 put every part of sending work on the same side of the line, and reputation risk turned out to be the wrong axis to split people on — a member who can add a domain, mint its keys and send from it can already do far more reputational damage than un-suppressing one address. The refusal it used to raise is gone; the address itself is still protected by the suppression's own reason and detail, which say why it landed there.

## An organization key manages keys, endpoints and settings; an admin key still doesn't

`/v1/keys`, `/v1/webhook_endpoints` and `/v1/organization` (#390) put three resources a customer administers on the API, where every other capability already is. Each needs a key with **no domain scope**, and a key mints only in **its own mode**.

**Why unlimited-only:** a key limited to domains could otherwise mint one limited to none, which is a widening, not a sideways move. Refusing it means the set of domains a key's authority reaches can never grow from inside the API. Same reasoning for webhook endpoints: an endpoint hears every event its key produces, so registering one is whole-organization work.

**Why same-mode-only:** a test key is what gets handed to a contractor or pasted into a CI config. Letting it mint a live key makes the sandbox a door into production for the price of one request.

**The same line holds past minting.** A test key sees and manages only test keys and their endpoints, and reads only test mail: live keys, live messages and their events read as not there. Received mail and exports are live data with no test half, so a test key gets `403 key_not_scoped` on them. Domains, lists, suppressions and organization settings aren't split by mode, and a test key still reaches them.

**Why no role check.** #376 put key and endpoint work on the member side of the line, and a key carries its organization's authority with no person attached ("Admin is service-wide; an organization has owners and members"), so there's no role for a route to read. Organization settings are owner-only *in the dashboard* and stay that way; on the API the key is the authority, as it is everywhere else on `/v1`. The honest version of a narrower grant is a scope on the key, which is a different feature.

**What's still dashboard-only:** minting an admin key, for the reason above. A webhook signing secret is readable only on the key detail screen; the API returns it at creation and at rotation and never again, so a route can't turn a stolen organization key into every receiver's secret.

**Revisit when** keys carry their own capability scopes. A `keys:write` scope is what makes the unlimited-key rule redundant.

## An account can't be deleted out from under an organization it owns

Deleting an account cascades its memberships, so `deleteUserAccount` refuses when the account is the only owner of any organization (`assertOwnerRemovable`, `lib/memberships.ts`), the same way it refuses the last admin. Both checks run inside the delete's transaction, with the rows locked, so two concurrent deletes can't each see the other as cover.

**Why the removal guard wasn't enough:** removing a membership already refused to strand an organization, but deleting the person went around it — the foreign key cascaded the membership away without asking. Same end state, no refusal, and nobody left who could manage the organization or delete it.

**The way out is the same as the removal's:** make someone else an owner first, or delete the organization.

## Deleting an organization is domain by domain, and it takes the send history with it

`deleteOrganization` (`lib/organizations/delete.ts`) drops each domain and the identity behind it, then the organization's provider rows and the spaces they hold, then the row everything else cascades from (#388). Owners reach it in Settings, admins on Admin settings → Organizations and through `DELETE /v1/admin/organizations/:id`.

**The atomic unit is the domain, not the organization.** Each domain's row and its provider call share one transaction, exactly as `deleteDomain` does — the row goes first, so a provider failure rolls that domain back and an identity never orphans. One transaction spanning every domain was the other option and it's wrong twice over: it holds the whole organization's rows locked for as long as the slowest provider takes, unbounded in the number of domains rather than the bounded few minutes a single domain costs, and it makes one identity the provider won't release enough to stop a twenty-domain organization being deleted at all. A run that fails part way leaves the domains already dropped gone and the organization intact, which is recoverable and re-runnable; calling it again resumes.

**Sending history goes with it, and that doesn't contradict "the log is the record".** `domainDeleteBlock` refuses a domain that has messages because losing one domain's history while the organization keeps sending is a silent hole in its own record. Deleting the organization is deliberately taking the whole record, so the same refusal there would mean no organization that ever sent could be deleted — a customer who leaves could never be removed. `messages`, `batches` and `lists` are `restrict` against `domains`, so the delete clears them inside each domain's transaction before the row goes.

**Two things do block it,** both named in the refusal (`organizationDeleteBlock`, `lib/organizations/deletable.ts`, `organization_in_use`):

- **Mail waiting to send** — anything `queued` or `deferred`. It's mail Pouch has accepted and still owes. The way out is to wait, or to suspend the organization, which fails the queue with a reason.
- **The domain system mail sends from.** Deleting it would take password reset down for the whole install, and the setting only says so at send time. Point the system from address elsewhere first.

**The cascade's order is not left to Postgres.** `messages.domain_id`, `lists.domain_id`, `batches.domain_id` and `dns_provider_records.dns_provider_account_id` are `restrict` against a sibling that cascades from the organization too, so a plain `DELETE FROM organizations` depends on which cascade trigger fires first. The delete removes each child explicitly instead.

**A shared provider survives.** It carries a null `organization_id` ("A null organization means the row belongs to the service"), so neither the cascade nor `releaseProviders` can select one. The organization's own row on it — its tenant — is torn down through the adapter, the same call `offboardOrganization` makes.

**A person's last organization goes too, and they land on `/start`.** Refusing it would deadlock against "An account can't be deleted out from under an organization it owns": someone who is the sole owner of their only organization could then delete neither. So `requireOrganization` sends a signed-in person with nothing reachable to `/start` to create one, rather than to `/login`, which looped — the login screen sends a signed-in user back to `/`.

**Revisit when** an export has to run before the delete, or a deleted organization needs a grace period before its provider identities go.

## Admin keys die with their creator's admin role

An admin-scope key records `created_by`. Demoting or deleting the creator revokes their admin keys in the same transaction (`lib/auth/admin.ts`), and `authenticateSecret` refuses an admin key whose creator isn't an admin (`lib/api/keys.ts`). Only an admin mints one, only in the dashboard, and it belongs to no organization (#374). They don't expire.

**Why:** an admin key can create providers, rotate credentials and suspend any organization. Tying it to a person means removing the person removes the key, including a flag changed in SQL. Minting only in the dashboard means a leaked key can't make more.

**Revisit when** an admin key needs to outlive a person, such as a service provider for automation.

## Removing a member doesn't revoke the keys they created

Removing someone from an organization removes the membership and nothing else. Their account stays, and every organization key they minted keeps sending. The remove prompt carries a line saying so and pointing at rotation (`app/(app)/settings/members-section.tsx`).

**Why:** an organization key carries the organization's authority, not a person's. Revoking on removal would take live sending down whenever a contractor leaves — an outage bought for a risk that rotating the keys already answers, on the organization's own schedule. The person losing dashboard access is the removal; the key is a separate decision.

**Why this doesn't contradict "Admin keys die with their creator's admin role".** An admin key is service-wide authority granted by one person's flag, so removing the flag has to remove the key. An organization key is never personal in that way. Same word, two authorities.

**Why the prompt says it rather than a warning.** Not doing something isn't a hazard to interrupt over. It's a line under the confirmation, for the admin who assumed otherwise.

**Context:** #398 removed `setMembershipRole`'s key revoke as unreachable once roles became `owner | member`, which surfaced the question.

**Revisit when** a key can be scoped to a person. Then removing the person is removing their key, and this stops being a choice.

## People are managed by admins on the API, by owners in the dashboard

`/v1/admin/organizations/:id/members` lists members, changes a role and removes one (#392). There's no organization-key equivalent, and the dashboard's Settings → Members is owner-only. Both surfaces call `lib/memberships.ts`.

**Why admin-only on the API:** a role change grants a person standing access that outlives any key rotation. An organization key records who minted it, not who is using it ("Admin is service-wide; an organization has owners and members"), so a `/v1/members` route would let a leaked key turn itself into a permanent human account on the organization — a wider grant than anything else on `/v1`, and one rotating the key wouldn't undo.

**Why owner-only in the dashboard:** a session carries a person and a role, so the check has something to read. That's the same line #376 drew.

**Adding someone is an invitation, and it follows the same line** (#440): `/v1/admin/organizations/:id/invitations` on the API, owner-only on Settings → Members, both through `lib/invitations/`. See "An invitation is the only way an account is created".

**Revisit when** keys carry their own capability scopes.

## An invitation is the only way an account is created

Public sign-up is off, so an owner invites an address, `sendSystemMail` carries a one-time token and `/accept` redeems it (#440). The capability is `lib/invitations/`; the route, the MCP tool and the three server actions are adapters over it.

**The route is admin-scoped, not an organization key's.** `POST /v1/admin/organizations/:id/invitations` sits beside the members routes for the reason that put them there: an organization key records who minted it, not who is using it, so an org-key invite route would let a leaked key mint a permanent human account with a password the attacker chooses — a standing grant that rotating the key wouldn't undo, and a wider one than any other `/v1` route hands out. The dashboard's session carries a person and a role, so owner-only holds there.

**An address that already has an account gets a membership, never a second person.** `redeemInvitation` refuses to set a password on an existing account and `acceptInvitationAs` takes the signed-in session instead, checking that its address is the invited one. A token that could set a password on an existing address would be an account takeover primitive, which is the whole reason the two paths are separate functions rather than one branch.

**One live invitation per address per organization**, held by a partial unique index (`invitations_pending_idx`). Two live tokens double what a leaked mailbox is worth and make "revoke" ambiguous about which link died. Resend covers the real need: it issues a new token, resets the 7-day window and kills the old link.

**Expired and already-accepted say which they are.** Both are dead ends that grant nothing, and telling them apart is what turns a support ticket into a next step — "ask for a new one" against "sign in". A stale link's holder learns only that the invitation reached its recipient, which is strictly less than the live screen already shows them: the organization's name and the invited address. A revoked or unknown token says neither, because there's nothing useful to say and a revocation is the one state an admin deliberately made silent.

**Rate limiting is the password reset's, not a new mechanism.** `consumeRateLimit` in the capability, per organization (`INVITE_RATE_LIMIT`, 10 a minute) and per invited address (`INVITE_EMAIL_RATE_LIMIT`, 3 a minute). It lives in `lib/invitations/` rather than the route because the dashboard action is the surface that isn't already behind a key's own limit.

**A failed send leaves nothing behind.** The row is written before the mail, so a `SystemMailNotConfiguredError` deletes it and answers `503 provider_unavailable`. A pending invitation nobody received is worse than no invitation: it holds the unique index and reads as sent.

**Admin stays a flag someone grants afterwards.** There's no invite-as-admin: one invitation concept, and `users.admin` is granted in Admin settings once the person exists, deliberately and separately. The two access axes don't read each other and an invitation is org-scoped, so an invitation that also set a service-wide flag would be the one place they crossed.

**Revisit when** public sign-up opens (#292). The accept screen is still the join path, but it stops being the only door.

## It's an activity log, not an audit log

`recordActivity` is best-effort: if the write fails, the request that triggered it still succeeds.

**Why:** "audit" promises a completeness this deliberately doesn't keep. Naming it honestly is what stops someone relying on it as evidence.

What records: routes that change provider configuration — domains, suppressions, providers. What doesn't: reads, and accepting a message, which the message log already records far better. Logging every send here would drown what the log exists for.

## Each action declares how long its rows live and what it may keep of the client

An entry in `ACTIVITY_ACTIONS` (`lib/activity/taxonomy.ts`) carries `retentionDays` (null keeps it) and `client`, whether the address and user agent may be stored. `recordActivity` drops what the action doesn't allow. The worker's `activity-retention` loop deletes past each action's period, hourly in batches of 1,000, up to 50 batches a pass (`lib/activity/retention.ts`).

| Kept | Actions |
|---|---|
| 90 days | sign-in, sign-out, failed sign-in, password reset; list member adds, imports, updates and removals, and unsubscribes; domain pauses and releases, reputation changes (domain and organization), DNS applied and removed; provider findings opened and closed; retention and abandon sweeps |
| 2 years | keys, domains (added, adopted, verified, deleted, layout, moves, inbound, bulk), suppressions, settings, members and invitations, webhook endpoints and secrets, providers, lists created, changed and deleted, emulation, exports, auto-disabled endpoints |
| indefinitely | organization created, deleted, suspended and released; admin granted and revoked; account deleted |

Only `session.signed_in` and `session.sign_in.failed` keep the client: a keyed hash of the address (`ip_hash`) and the user agent. Every other action stores neither. An action the taxonomy no longer lists is never deleted.

**Why:** the writer of an event knows whether it's evidence or noise. Sign-in rows and list-member churn are high-volume and only useful while someone could still act on them. Setup changes answer "who changed this" for as long as the thing exists, so they keep two years. What ends an organization or grants service-wide authority is rare and kept. The address is the one thing here that identifies a person, so the row holds the same keyed hash the rate limiter does (`hashIp`, `lib/api/client-ip.ts`), never the address: two rows from one client still match, and a database read yields no IP.

**This isn't a conflict with "activity log, not an audit log".** That entry says nobody should rely on the log for completeness. A log that expires is the same claim made stronger. Activity stays append-only: nothing edits a row, only the loop removes them, by age.

**A failed sign-in is recorded server-side.** `hooks.after` in `lib/auth/index.ts` records it when `/sign-in/email` returned an error. It was a client-called server action, which let anyone write failure rows into any account's feed.

**Better Auth's own session table still stores the raw address** for the sessions screen. That's Better Auth's schema, not this log.

**Revisit when** an organization needs its own period, or a customer or regulator needs the 90-day rows kept. Removing an action's `client` doesn't blank existing rows; scrub them once from a migration. Rows are only deleted while the worker runs.

## Activity names a list member by id, never by address

`list.member.added`, `list.member.removed`, `list.unsubscribed` and `domain.unsubscribed` store `membershipId` or `domainUnsubscribeId` in metadata. The feed reads the address from that row while it exists (`lib/activity/query.ts`), the same way `suppression.added` does. Once the row is gone, the feed shows the id: `member lmb_…`.

**Why:** an address in the log outlives the membership, so deleting the membership wouldn't purge it. The id is random, so it reveals nothing once the row is deleted, and an API caller that removed a member already holds it.

**Why not a hash of the address:** addresses are guessable, so a hash still answers "was this address on the list?" after a purge.

**Why not a soft delete:** the membership row would keep the address, which is what a purge has to remove.

`0045_activity_list_addresses` strips addresses from rows written before this and points each at the membership or stop that still holds the address, when there is one. It's a single `UPDATE` per action. Activity is append-only, so the row locks it takes block nothing.

**Revisit when** per-address purge is built. It deletes the memberships and domain stops for the address, and the log needs nothing more.

## A setting is editable; a record isn't

Things a customer configures have an update path on every surface that owns them: a list's name and opt-in mode, a member's attributes, a key's name and scope, an endpoint's URL, description and events, an organization's name and retention. Things that record what happened don't, and correcting one means writing a new row, not editing the old:

- **A message, a batch and its events.** Accepted means persisted; the log is what the message was, not what someone later wished it had been.
- **An inbound message.** The same, from the other direction.
- **An export.** A snapshot of a query at a moment. A different answer is a different export.
- **A suppression's reason.** Remove the address and import it again — `docs/api/conventions.md` already says so, and a reason that can be edited stops being evidence of why the address stopped receiving mail.
- **A membership's address, status and source.** A different address is a different person. Status moves through the confirm and unsubscribe doors so consent always has an act behind it, and source is how the membership got here.
- **An activity row.** Append-only, by definition.

**Why:** "you can create it but not change it" is usually an unfinished screen, and the CRUD audit (#391) found six. But the fix isn't an update path everywhere — it's deciding which side of the line each resource is on and saying so, so the next audit reads the absence as a choice.

**Revisit when** a record needs correcting often enough that a superseding row, carrying what it replaces, is worth building.

## One clock

Any timestamp the database will compare against another comes from `dbNow()`, read once per operation. Detail in `docs/engineering.md`.

**Why:** the app wrote timestamps with the Node clock while the queues compared them against Postgres `now()`, so what counted as due depended on the skew between two machines. It produced nine test failures on one run and none on the next from the same commit, and it shifted real retry timing in production.

Read-side "last N days" window filters still use the app clock deliberately — they're day- and hour-scale, and a round trip per list query would cost more than it buys.

## The dashboard shows time in the viewer's zone; everything else stays UTC

`users.time_zone` holds an IANA name, null for UTC, set in user settings and validated against the runtime's own list (`lib/time-zone.ts`). The session carries it, and the dashboard formats every date, day heading and daily bucket in it: `localDay` (`lib/dashboard/local-day.ts`) for the SQL, `TimeZoneProvider` for client components. Midnight-aligned windows start at local midnight; rolling ones ("last 30 days" as 30 × 24 hours) don't move.

**Why only the dashboard:** API responses, exports and webhooks are read by programs, and a timestamp that changes with who's asking is a bug for them. Digests and alerts are UTC: admin alerts go to the system address, not a person, and a digest's window is one UTC calendar window shared by every admin it goes to.

**The zone is inlined into the SQL, not bound.** A bound parameter renders as a different placeholder in the `select` and the `group by`, and Postgres refuses the query. `localDay` checks the name against the list first.

## Errors are scrubbed by allowlist, and reporting is off without a DSN

Outbound error reports are rebuilt from an allowlist of fields, with stack-frame locals dropped outright. Nothing is sent unless `GLITCHTIP_DSN` is set.

**Why:** this service handles other people's mail. Recipient addresses, subjects and bodies pass through the code paths that throw, so an error tracker without scrubbing becomes a copy of the message log. An allowlist fails closed when someone adds a field; a denylist fails open.

## Browser errors come in through one unauthenticated route, and the server decides what's kept

`POST /client-errors` takes a route, a digest or a message from the dashboard's error boundaries and passes it through the same `reportError` and allowlist as a server error. It's rate-limited per hashed address, capped at 2 KiB, strictly validated, and does nothing without `GLITCHTIP_DSN`. The release comes from the server's own `GIT_SHA`, never the client. `digest` joined the allowlist so a server render error can be matched to its log line.

**Why:** a screen that only breaks in the browser was invisible until someone reported it. The route can't be authenticated, since a render error may be the login page itself, so what it accepts is narrow instead: the schema rejects any field it doesn't name and any route with a query string or fragment, and the reporter redacts the message. `global-error` sends only the first path segment, because it can fire on a page whose path is a one-time token.

**Why no same-origin check:** `Origin` and `Sec-Fetch-Site` stop another site's page, not `curl`, so they'd guard nothing the rate limit and scrubber don't. The route does require `application/json`, which makes a cross-site browser post preflight, and the route answers no preflight.

**Revisit when** the reporter's per-fingerprint limit (20 a minute) isn't enough against a spread of addresses, or a boundary needs to send a stack or component name.

## A compliance header only counts if the provider will carry it

`List-Unsubscribe` clears a fan-out hold on `POST /v1/emails` only when the domain's provider carries custom headers at all. A domain on a provider that doesn't gets `bulk_not_allowed` instead of a chance to add the header.

**Why:** Mailpace drops every custom header in transit. Checking only for the header's presence on the request would have let a caller "clear" the hold with a header that never reaches the recipient — a guard satisfied without achieving what it guards is worse than no guard, because it also tells us we're covered when we aren't. Mailpace is transactional-only by its own terms besides, so a domain there crossing the fan-out threshold is a terms problem, not only a compliance one; the fix is moving the domain, not adding a header.

**What's not built:** there's no admin override for a hash that's a known-legitimate false positive — a service outage notice or a terms update identical across recipients trips the same hold as a real blast, and the only way through today is the same one a blast would need: `List-Unsubscribe`, where the provider allows it.

## Feedback-ID carries the organization, not a message-level id

`worker/send.ts` sets `Feedback-ID: <organization id>:<mail type>:pouch` on every send, unless the caller already set one or the provider drops custom headers — see `lib/messages/feedback-id.ts`. Format and the mandatory sender id's length are Google's (support.google.com/mail/answer/6254652).

**Why the organization, not a per-message value:** #297's research found `FEEDBACK_LOOP_SPAM_RATE` is keyed by this header, so it's the one lever that splits Gmail's spam rate by tenant on a domain several organizations share. A per-message id would tell Google nothing repeatable to aggregate on.

**Why it's skipped for a provider that drops custom headers:** same reasoning as List-Unsubscribe above — a header the recipient's server never sees isn't worth the field.

**Revisit when** #297's Postmaster Tools API integration ships and reads `FEEDBACK_LOOP_SPAM_RATE` back — the header shape here is what that work depends on already existing.

## Pouch's own mail is one setting: the from address

System mail — confirmations, layout previews, as-needed admin alerts, digests — sends from the address `service_settings.system_from_address` holds (`lib/mail/system.ts`), never a `system` flag on `messages`. The address resolves everything else: its domain has to be verified in some organization, and that organization's provider and tenant carry the send. The message is the service's (see "System mail belongs to the service, and the organization holding its domain only carries it"). Unset, it's `support@` on the oldest verified domain on the install (#379). As-needed alerts go to `service_settings.system_alerts_to`, one message per address, or to the from address while it's unset. Like the from address, it's dashboard-only.

**Why the address, not a domain pointer:** the from address is what an admin wants to define and what a recipient reads; the sending domain is an implementation detail of it. #373 configured the domain and hardcoded `support@` from `lib/brand.ts`, which is two concepts where there's one and no say over the local part.

**A domain name can repeat across organizations.** `domains_name_idx` is unique per organization, so an address resolves to the verified row for that name, oldest first. Admin settings → General names the resolved organization beside the field, so where mail lands is on screen rather than inferred.

**An address that can't send is refused at save.** The admin action resolves before it writes, so a typo or an unverified domain never becomes the stored setting. Drift after the fact — the domain deleted or unverified later — still throws at send time.

**The control is a local part plus a select of verified domains** (#410), not a free-text address. The setting is still one full address, but the half that can be wrong — the domain — can only be picked from rows that already exist, so the "not configured" state is drift after the fact rather than something a save can create. A free-text field was how #382 traded the domain pointer for the address, and it let an admin type a domain nothing on the install had verified.

**Why a domain Pouch doesn't own:** an SES identity carries one owner tag, so a system organization that owned `pouch.email` would fight the admin's own organization for it. And for one user with one organization and one domain, an organization they never created is the wrong answer. Borrowing the domain covers both: the single-tenant install configures nothing, and anyone wanting Pouch's mail on its own reputation creates an organization and sets the address to one of its domains.

**Why not a `system` flag on `messages`:** every rate query would have to remember to exclude it, and one forgotten `where` makes the numbers wrong in the direction nobody checks.

**The system organization is gone** (#374). Shared providers and admin-scope keys hold a null organization instead, which is what "belongs to the service" means.

**No API key is involved.** System mail sends through `acceptDashboardMessage` — organization scope, `api_key_id` null — the same path a dashboard send takes. Requiring an active key in the resolved organization would put back the configuration step this setting removes, for nothing: the organization's session-holders already reach every domain it owns.

**A dangling address stops mail; it doesn't reroute it.** The setting is text with no foreign key, so deleting or unverifying its domain throws `SystemMailNotConfiguredError` naming the setting, rather than silently falling back to some other organization's domain. Mail from a stranger's domain is worse than no mail.

**One template, both parts** (`lib/mail/template.tsx`). Every system email is a React Email component that renders `SystemMail`: Pouch's mark, a heading, a short body, one button with its URL beside it as text, and a footer saying why the reader got it (#529). Each alert in `lib/mail/alerts/` and the digest is one. `renderSystemMail` renders the HTML with `@react-email/render` and derives the plain-text part from the same props, not from the HTML, so the text keeps its own shape: status marks as `[!]`, links on their own lines. Tables and inline light colors so Outlook and Gmail render it; dark colors override from the `<style>` block, and Outlook gets the button as VML. The one image is the mark, a PNG pair served from the app's own `/mail/` path because most clients don't render SVG. Every recipient gets the same URL, so it tracks no one, and its alt text stands in when images are off. Rendering happens in the app server and the worker, never the browser.

**Why React Email:** it's the most established way to build mail from React components. Components come from `react-email`, which absorbed `@react-email/components` in v6 and deprecated it.

**Never `noreply@`.** These messages invite a reply — "a webhook endpoint disabled itself" is exactly the kind of thing someone writes back about — so the address is real until inbound (#6) gives it somewhere to land automatically.

**The cost:** the resolved organization's suspension stops system mail, password resets included. That's the same failure an owned domain had when its own provider was paused, one organization over.

**Supersedes** the #373 domain pointer (`service_settings.system_mail_domain_id`, migrated to the equivalent address in `drizzle/0051_system_from_address.sql`) and, before it, the #358 shape where the system organization owned its own provider, tenant and domain.

**`organizations.from_address` is gone** (#379). It fed the old system organization and nothing else; every sender names its from address per message, so the column was a control whose hint — "Blank uses the service default" — described a default that no longer existed.

## The default provider for new organizations is a pointer in service settings

`service_settings.default_provider_id` names the shared provider a new organization is onboarded onto (#410). It was `providers.onboard_new`, a boolean toggled on an individual provider's detail screen — service-wide policy readable only by opening each provider in turn.

**The pointer keeps the invariant it replaces.** `providers_onboard_new_idx`, a unique index partial on the true rows, made two defaults impossible; one nullable column does the same by construction. The foreign key is `on delete set null`, so deleting a provider clears the setting rather than leaving it naming a row that's gone.

**The check constraint becomes validation.** `providers_onboard_new_check` said only a shared provider could be the default. A pointer can't express a predicate about the row it points at, so `setDefaultForNewOrganizations` (`lib/providers/shared.ts`) checks it on the write path, which both the screen and the admin API go through.

**`default_for_new_organizations` stays on the wire.** The admin API serializer computes it from the pointer, and `PATCH` still takes it: `true` moves the pointer, `false` clears it only when it names that provider. The provider screen keeps the chip, read-only, because the question "is this the one?" is still worth answering where you're standing.

## Admin settings splits by what you set and what you read

General is service-wide policy — system mail, the default provider for new organizations. System is diagnostics — worker loops, stuck locks, queue by organization, unconfirmed sends, provider limits and reputation (#411). The test for a tab is whether it answers "what is Pouch configured to do" or "what is Pouch doing right now".

Before the split General was one diagnostic card, the worker fleet, which System then repeated as the header of "Worker loops"; system mail, a setting, sat on the diagnostics page. The fleet is now the top of the loops section rather than its own screen: the loops already list workers per loop, so the fleet is that section's header, not a page.

## Organization settings is three tabs: General, Members, Sending

`/settings` is route-based tabs sharing one nav component with admin settings, `app/(app)/_ui/settings-nav.tsx` (#420). Each tab is its own page, so the back button and reload behave; that's the same reason the admin nav was links rather than Radix tabs.

The grouping runs the same test #411 gave admin settings, read as an owner rather than an admin. **General** is the shape of the organization: name, slug, owners, body retention and deleting it — every write on it owner-only, and the delete a section at the bottom rather than a fourth tab, because it's the last thing you do to the same object the tab already edits. **Members** is people, owner-only to change and readable by both roles. **Sending** is what the organization's mail is doing: the assigned provider, whether blocklist checks run, what's queued and which observations are on. The first three are reads here — an admin assigns the provider and sets the Spamhaus key, and the queue is a number — so they're one tab, not three. Observations (#558) are the tab's one write: owners turn each on or off and remove its tag and key mutes.

**Why not a tab per section.** Six sections were six candidates, and Blocklist checks and Queue would each have been one card answering one question. A tab the reader opens once to read two lines is a worse home for them than a section on the page they'd already be on to ask about sending.

**Nothing is hidden from a member.** There's no read-only role (see "Admin is service-wide; an organization has owners and members"), and both roles read everything the organization holds, so a member sees all three tabs with the owner-only controls disabled and a tooltip naming what's needed — `RoleGate`, backed by `requireOrganizationOwner` on the actions themselves. Hiding a tab would tell a member less than the disabled control does.

## A null organization means the row belongs to the service

`providers.organization_id` and `api_keys.organization_id` are nullable, and null means the row is the service's own: a shared provider, or an admin-scope key. Check constraints hold both directions — `shared` is true exactly when the organization is null, and `scope = 'admin'` exactly when it is (#374). `activity.organization_id` is nullable for the same reason: a service-level write records against no organization. So are `messages`, `message_events`, `suppressions` and `message_hourly_stats` (#579): system mail and what follows from it.

**Why not a reserved organization:** the system organization existed only because two columns were `NOT NULL`. Once system mail pointed at a real domain (#372) it owned nothing, sent nothing and still showed up in every admin organization list. A column that says "no organization" is the honest version.

**Name uniqueness:** a shared provider's name is unique across shared providers, through a partial unique index on `name` where the organization is null. Per-organization uniqueness is unchanged. Shared providers are one list on one admin screen, so two rows named "Hosted" read as a bug there for the same reason two do inside an organization.

**Deleting an organization can't reach a service-level row.** The foreign key is `on delete cascade`, and a null never matches it, so its own providers and keys go and shared providers and admin keys stay.

**An admin key on an ordinary `/v1` route is refused** with `organization_key_required`, rather than acting as some organization. `/v1/admin/*` covers the admin surface, and SMTP AUTH refuses one at login.

## Sign-in is password, passkey or an emailed link, and a link never creates an account

The login screen offers three ways in. A password and a passkey are credentials the person set up while signed in. An emailed link (`lib/auth/magic-link.ts`) proves control of a mailbox, which a password reset already does, so it adds no new trust root.

**The link and the passkey lead; the password is the alternative.** /login opens on the email field with "Email me a sign-in link" as the primary action and "Sign in with a passkey" beside it. "Use a password instead" reveals the password field, keeps the typed email and moves focus there; `/login?method=password` opens it directly. Without system mail the link can't work, so the password form is open, the link option is absent rather than disabled, and the passkey stays secondary (`app/(auth)/login/login-methods.ts`). A failed password sign-in keeps the form open.

**A link never creates an account.** `disableSignUp: true` on the plugin, and the request guard answers an address with no user without calling it. The plugin on its own mints a token and calls `sendMagicLink` for any address, so the check lives in two places: the guard (no row written) and `sendMagicLinkMail` (no mail). "An invitation is the only way an account is created" holds.

**Unknown and known addresses get the same answer.** `200 {"status":true}` and a "check your email" screen that says "if an account uses". The rate limits count every request, so a 429 reveals nothing either. The answer's timing differs slightly: a known address writes a token row, and the mail is sent in the background. A 503 for unconfigured system mail is the same for every address.

**Ten minutes, single use, stored hashed.** The plugin defaults to five minutes and plain storage. Pouch sets `expiresIn` to 600 and `storeToken: "hashed"` (SHA-256, base64url), so a database read can't redeem a live link. The plugin consumes the row atomically on first use, expired or not. `allowedAttempts` is ignored by the installed version.

**The email opens a confirm page, not Better Auth's verify URL.** Mail scanners fetch links, and a GET that signs in would spend the token before the person clicks. `/login/link` shows a button whose server action calls `magicLinkVerify`.

**Rate limits are the reset's mechanism:** `MAGIC_LINK_RATE_LIMIT` per hashed client address (5) and `MAGIC_LINK_EMAIL_RATE_LIMIT` per address (3), each per minute.

**Activity.** Passkey and link sign-ins record `session.signed_in` from an after hook on the new session, with the hashed address, user agent and `metadata.method`. Requests record `session.magic_link.requested`, 90 days, client stored.

**Admins get links too.** Mail that carries a credential is withheld from the message log (see "Mail that carries a credential is never readable from the log"), so the log gives no one a link to use. That removes the one reason to keep admins off links.

**Passkey sign-in requires user verification.** The plugin fixes authentication's `userVerification` at "preferred" and has no option for it, so `requireUserVerification` (`lib/auth/passkey.ts`) rewrites the options response and `refuseUnverifiedUser` refuses an assertion that lacks the flag. Registration asks for it through the plugin's `authenticatorSelection`. A passkey made earlier on a key with no PIN or biometric can't sign in; password and link still work.

**The last credential can't be removed from a password-less account, through the API as well as the dashboard.** The plugin's `/passkey/delete-passkey` is callable directly, so `guardLastCredential` runs before it.

**An admin turns each method off** in Admin settings → Access, and the server refuses it while it's off. See "Access is three settings: sign-in methods, session length and who creates organizations".

## Mail that carries a credential is never readable from the log

`sendSystemMail` takes `withhold`, a phrase completing "it contained ...". Password reset, sign-in link, invitation and forwarding confirmation set it. The message is stored and sent as any other, because the worker reads the stored body to send it. `messages.body_withheld` then makes every read answer "Body withheld: it was marked as sensitive because it contained a sign-in link." — the dashboard, `include=body` and `include=rendered` on the API, MCP, the export and attachment downloads — whether or not the key still exists. Once the message leaves `queued`, the retention sweep shreds its key, whatever the organization's retention window says.

**Why shred after sending, not redact before.** A redacted body would be the body that went out, and the recipient needs the real link. Not storing the body would leave the worker nothing to send. The window is the time the message sits queued, and reads are closed for all of it.

**Envelope and events stay.** To, subject, status and events are kept, so delivery is visible. A shred writes a `body_shredded` event.

**Existing mail.** Migration `0077` marks messages already sent with these tags, a null API key and the sender's idempotency prefix (`password-reset:`, `magic-link:`, `invitation:`, `forward-confirm:`) and shreds their keys. A tenant's own message tagged `password-reset` carries a key and no such prefix, so it stays. Queued ones are marked and shredded by the sweep after they send.

**A new sender of a credential has to set `withhold`.** A test reads the four senders for it.

**Revisit when** a message kind needs its body shown to someone, such as a support view of an invitation. Then withhold the link, not the message.

## A sender marks a message sensitive, and nothing makes it readable again

`"sensitive": true` on `POST /v1/emails`, or `X-Pouch-Sensitive: 1` over SMTP, stores the message with `body_withheld` set to an empty reason. Everything in "Mail that carries a credential is never readable from the log" then applies: every read refuses the body, the sweep shreds the key once it sends and a resend is refused.

**The sender decides.** Pouch never scans a body to guess. It can't tell a sign-in link from any other link reliably, and a missed guess would look like protection that wasn't there. Marking every message sensitive is allowed: the delivery record stays, and the body is the sender's to give up.

**No bypass.** No setting, admin override or debug option ever makes a withheld body readable. An escape hatch is the first thing an attacker or a curious admin looks for, and having one makes the mark a policy rather than a fact.

**Bulk doesn't take it.** `POST /v1/batches` has no per-message options beyond attributes, and list mail carries no credential.

**Revisit when** a sender needs a body back for support. That's a copy the sender keeps, never a read through Pouch.

## Password reset is email through the system from address

"Forgot password?" emails a reset link through `sendSystemMail` (#282). Until the system from address resolves to a verified domain, `/api/auth/request-password-reset` answers 503 for every address and the page says so, naming the setting and `pnpm reset:admin`.

**Why not passkeys as the recovery factor:** a passkey only helps someone who registered one before losing the password. Email covers every provider.

**The circular case stays:** an install whose own mail is broken can't send its own reset. `pnpm reset:admin` is the fallback for that, not a replacement.

**The link is withheld from the message log** ("Mail that carries a credential is never readable from the log"). It works once and lasts an hour.

**Revisit when** a reset needs a second channel.

## Digests are the service admin's, not an organization's

`lib/mail/digest/` sends daily, weekly and monthly summaries addressed to each opted-in admin's own account email, never to an organization's owners. The numbers inside span every tenant — volume, delivery, bounce and complaint rate, the same cross-organization scope as the admin system screen (`lib/system/read.ts`) — so an organization's owners have nothing to do with them.

**Why:** the as-needed alerts already shipped in #96's foundation send to system mail's own from-address, i.e. whoever reads it — the admin. A digest that instead went to every organization's owners would need per-tenant content (their own volume, their own bounces), which is a different, unbuilt feature: an organization-scoped activity digest. Nothing in #96 asked for that; it asked for Pouch to be able to email about itself. Per-user preference (`digest_preferences`, one row per user, keyed off `users.admin`) decides which admins get which cadence.

**What's in it, and what's left out:** a digest reports the window as a record: volume by hour or day, outcome rates against the reputation lines, a split by provider and by organization, what moved to watch or worse, provider findings, webhooks that gave up, failed sign-ins, inbound and growth counts. Live state stays out: queue depth, stuck locks, loop health. Those depend on the service being up to deliver the news, so they're on the admin system screen and push (`docs/engineering.md`). A digest about the window stays true even when it lands late.

**Every line links to where it's handled.** Service-level lines open the admin screens. A line about one organization opens `/admin/settings/organizations?org=<id>&next=<path>`, which switches into an organization you belong to, or asks before emulating one you don't, then lands on `next`. Emulation stays a confirmed, recorded action: a link alone never starts it.

**Charts and icons are table cells, not images.** Gmail strips `data:` images and most clients don't render SVG, and inline images would need multipart support in every adapter. Bars are sized `<td>`s and status icons are styled badges, so the digest renders with images off and needs no attachments.

**Silence over a zero line:** a window with nothing sent across every tenant doesn't produce a digest at all, to any admin — no "0 sent this week." A quiet digest reads as confirmation the check ran; an empty one reads as noise.

**Scheduling rides its own loop** (`worker/digest.ts`, `digest` in `LOOP_NAMES`), ticking hourly. Almost every tick is a boundary check with no database read — `dueCadences` only proceeds at the `digest_hour` setting (UTC hour 0 by default), and only adds weekly on Monday or monthly on the 1st — so the loop's own heartbeat stays cheap while still reporting once an hour like every other loop on the admin system screen. The actual dedup against a worker restarting mid-run is the message's own idempotency key (`digest:<cadence>:<windowKey>:<userId>`), the same mechanism every as-needed alert already uses — the hourly gate only keeps ordinary ticks from recomputing metrics they'd throw away.

**Unsubscribing is a signed token, not a stored one** (`lib/mail/digest/unsubscribe.ts`): `HMAC(userId.cadence, BETTER_AUTH_SECRET)`, so redeeming a `List-Unsubscribe` link needs no lookup table and nothing to expire. `GET /unsubscribe/digest/:token` asks; `POST` (the page's button, or RFC 8058 one-click on `List-Unsubscribe-Post: List-Unsubscribe=One-Click`) flips the named cadence off, idempotently. This is a narrower mechanism than the token #7 specs for a tenant's mailing-list unsubscribe (address- and list-scoped, redeemable through a branded page) — a digest has exactly one recipient and one cadence to turn off, so it doesn't need that shape, and #7 landing later doesn't change this route.

## The dashboard reports infrastructure, it never controls it

Pouch shows what's running — workers, their heartbeats, queue depth, dependency health. It doesn't start, stop or scale anything.

**Why:** changing a worker count from the dashboard means reaching the Docker socket or a PaaS API, which gives an email service host-level privileges it otherwise never needs, for a job the host already does well. `docker compose up --scale mail-worker=3` is the interface. What the dashboard owes is an accurate picture of the result — see #168, where one shared heartbeat key reports three workers as one and a partial outage as healthy.

**Revisit when** someone is running Pouch without any way to reach the host, and even then the answer is more likely a documented deploy recipe than a button.

## A queued export's artifact outlives its request by a fixed, short window — never the org's retention setting

A queued export (past the row ceiling in `lib/exports/limits.ts`) writes its finished file to the private bucket and deletes it 7 days after it's ready, whatever the organization's `body_retention_days` says. The row then reads `expired`, not `ready`.

**Why:** the artifact is a second, unencrypted copy of content the retention setting otherwise governs — for a `bodies` export, decrypted message bodies a second time over. Tying its lifetime to that setting would mean a body already shredded from `messages.body_key` still sitting, readable, in an export bundle from before the shred. A short fixed window keeps it closer to a download link than to a second archive: long enough to actually download, short enough that nobody mistakes it for a place data lives.

**Revisit when** a real caller needs longer than a week to pick up a large archive — the fix there is a longer TTL as a setting, following "defaults follow convention" above, not an unbounded one.

## A queued export streams to storage and gives its claim back on shutdown

`worker/exports.ts` pipes the export's generators into a multipart upload (`lib/storage/stream.ts`) in fixed 8 MiB parts, so a build holds about one part plus one zip entry. Bodies are still decrypted one message at a time, whole: each is one AES-GCM object, so a single body can't stream.

- **1 GiB cap** (`EXPORT_MAX_ARTIFACT_BYTES`), checked as bytes stream. It keeps `size_bytes` inside an integer and the zip under its 4 GiB offset limit. Past it the row fails with the cap in its reason. A bodies zip also stops at 65,535 entries, since it doesn't write zip64.
- **Three attempts** (`EXPORT_MAX_ATTEMPTS`). A claim spends one. A clean shutdown aborts the build, discards the upload and puts the attempt back, so a deploy doesn't count. A SIGKILL still does.
- **A lease, not a fixed lock.** A running build renews `locked_at` and the loop heartbeat every 10 s. A row goes stale 10 minutes after its last renewal, and a worker that finds its claim gone discards its copy.
- **Crash leftovers are cleaned on reclaim.** `upload_id` and `object_key` are written as the upload starts, and the next claim aborts and deletes them. Incomplete multipart parts are decrypted content, so the bucket should also carry an abort-incomplete-uploads lifecycle rule.
- **Only a refusal's reason reaches the requester.** Any other error is logged and the row reads "This export couldn't be built."
- **Five jobs per tick stays.** They run one after another, so the count doesn't multiply memory, and a shutdown aborts whichever is running.

**Revisit when** a real caller needs more than 1 GiB, which would mean zip64 and a `bigint` size.

## `/v1/exports` always queues; only the dashboard streams synchronously

`POST /v1/exports` creates a queued export and returns `202` regardless of row count. The dashboard's own export routes still stream a small export directly, below the same ceiling.

**Why:** an API caller is already polling for a result either way, so giving it two response shapes — a raw file below the ceiling, JSON with a poll id above it — would make every integration branch on how much data happened to match. The dashboard keeps the synchronous path because it's serving a browser download, which is a real UX the API doesn't have.

## A stream's concurrency ceiling is a separate cap from the request rate limit, at 10 per key

`GET /v1/emails/:id/events` and `GET /v1/events` are held open, sometimes indefinitely. `lib/api/rate-limit.ts`'s per-minute limit counts requests; an idle connection sitting open isn't one in that sense, so it's tracked separately — a Redis sorted set per key, scored by expiry, rather than another draw against the existing sliding window.

**Why 10:** the legitimate case is a person watching a handful of sends from a terminal, or a CI job tailing a batch of test messages — not thousands of simultaneous long-lived connections. Ten is generous for that and still low enough that one caller can't pin every worker on connections that, unlike an ordinary request, never finish on their own. It's a setting (`MAX_CONCURRENT_STREAMS_PER_KEY`), following "defaults follow convention" above, not a hardcode.

**Why a sorted set instead of a plain counter:** a plain `INCR`/`DECR` leaks a slot forever if the process holding it crashes before decrementing. Scoring each connection's entry by an expiry a few heartbeats out and pruning expired entries on every acquisition attempt makes a crashed connection's slot free itself within the TTL, no reaper job required — the same self-healing instinct as the crypto-shredding and bucket-lifecycle patterns elsewhere in this file.

**Revisit when** a real integration needs more than a handful of simultaneous watches — the fix is raising the setting, not the mechanism.

## The brand stays quiet

`app/(app)/app-chrome.tsx` passes the mark alone — no wordmark beside it, sized to sit in a nav row rather than lead it, linking to Overview.

**Why:** Pouch is a utility that removes a friction point for developers. The API is the product, nobody signed in to a dashboard needs telling which app they're in, and the room across the top of the shell is worth more to the nav than to a logo. Overview keeps its own nav item; the mark links there because people click logos out of habit.

**This is a posture, not a ban.** Branding isn't automatically wasted space — showing the full mark somewhere it earns the room is fine. What's ruled out is the app taking up space to assert itself.

**Revisit when** Pouch is embedded or white-labeled somewhere the mark has to be configurable.

## The wire token is frozen and unique, separate from the brand

Everything a recipient or an external system reads the product's name out of comes from `WIRE_TOKEN` in `lib/wire.ts`: the `X-Pouch-*` headers on an exported `.eml`, the `pouch-<kind>-<date>` export filenames, the MCP server name and the class names on the frame we wrap mail in. Its value is `pouch` and it stays `pouch` if the product is renamed. Display copy keeps coming from `lib/brand.ts`, which reads nothing from `lib/wire.ts` and is read by nothing in it.

**Why unique, not neutral:** exported mail travels through other people's MTAs, filters and archives, and a generic prefix like `X-Mail-*` is the one that collides — something else may already write it with a different meaning. A distinctive token can't. Every vendor does this for the same reason: `X-SES-*`, `X-Mailgun-*`, `X-MC-*`.

**Why frozen, not derived:** a display name should be free to change and a wire identifier is a contract someone else parses. Deriving the headers from `brand.name` means a rebrand silently changes what every consumer matches on. The two spell the same thing today by coincidence, not by reference.

**`X-` stays** even though RFC 6648 deprecates it for new headers. Nothing enforces that for mail, and `X-` is what consumers expect.

`tests/unit/wire.test.ts` pins the token and everything built from it, so a change has to be deliberate. It's a test of a constant on purpose — that's what a wire contract is.

**Revisit when** a consumer is actually parsing these and a break has to be coordinated, not before. Renaming the product is not a reason.

## Inbound's domain webhook reuses `webhook_endpoints`, not a second table

`webhook_endpoints.api_key_id` is nullable now, and `domain_id` joins it as the other owner a row can have — never both, never neither (`webhook_endpoints_owner_check`). A domain's one inbound endpoint is a row here with `events: ["inbound.received"]`, delivered through the exact same `webhook_deliveries`/`webhook_attempts`/`WebhookLoop` every outbound event already uses: HMAC-SHA256, the same backoff schedule, the same auto-disable after consecutive exhausted deliveries.

**Why not a second delivery table:** #6 says explicitly not to build a second one, and the shape a domain endpoint needs — a URL, a secret, a disabled flag, a last-success/last-failure pair — is identical to what a key endpoint already has. A key-scoped endpoint picks its events from an allow-list; a domain endpoint doesn't pick anything, it's always `inbound.received`. That's an application-level rule (`upsertDomainEndpoint` never takes an `events` argument), not a reason for a second table.

**Inbound's own verification is per domain, not per provider.** `domains.inbound_provider_settings` holds what a provider's inbound callback needs to check — Mailpace hands out one Ed25519 keypair per domain, confirmed against docs.mailpace.com/guide/inbound and docs.mailpace.com/guide/webhooks before writing any code (see the PR body for #6). This is why `Adapter.inbound.verify` takes the domain's settings as an argument instead of closing over the provider's, unlike `Adapter.events.verify`.

## Mailpace's inbound DNS record is a CNAME, not an MX

`lib/providers/adapters/mailpace.ts`'s `inbound.records()` proposes a CNAME (`inbound.<domain>` → `inbound.mailpace.com`), never an MX.

**Why:** #6's framing described inbound DNS generically as "MX rows," which is true for SES and Cloudflare but not Mailpace — its own docs are explicit that inbound routes through a CNAME to `inbound.mailpace.com`, not a mail-exchanger record. Every adapter proposes whatever its provider's current docs actually say, `required: false` in every case, since inbound is opt-in and never gates a domain's own send verification.

## Inbound recipients: SES has the envelope, Mailpace doesn't

SES announces the receipt's envelope recipients (`receipt.recipients`), so Bcc'd and forwarded mail routes by who it was delivered to. Mailpace's inbound payload has no envelope recipient (docs.mailpace.com/guide/inbound). Its adapter takes the union of `to`, `cc` and `bcc`, plus any `Delivered-To`, `X-Original-To` or `Received ... for <addr>` in the headers or raw message, all parsed by `lib/inbound/recipients.ts` into bare, deduplicated addresses. The hints only add.

**Consequence:** a true Bcc through Mailpace routes only when Mailpace fills `bcc` or adds a delivered-to header. Otherwise it reaches the domain's webhook.

**Revisit when** a Mailpace inbound domain exists to capture a Bcc'd payload (#488).

## SES inbound rides the provider's event topic; the bucket is the admin's

Enabling inbound on an SES domain adds one receipt rule for `<subdomain>.<domain>` to the account's active rule set. Its S3 action writes to the provider's `inboundBucket` under `inbound/<domain id>/` and announces on the row's existing event topic, so the notification reaches `/api/webhooks/ses/<provider id>` already signed, subscribed and retried. The receiver checks whether the message is already stored before it reads anything, then reads the object, parses it with `mailparser`, ingests it through the same path as every other adapter and deletes SES's copy. A retry of an ingested message is a duplicate, not a missing object.

**Why the event topic, not a topic per domain:** a second topic means a second subscription to confirm and a second route to verify, for mail the existing route already authenticates. The object key carries the domain id, and ingest checks the domain is bound to the provider the callback verified as.

**Why the bucket is a credential field:** Pouch creates topics, not buckets. A bucket needs a policy letting SES write to it and a lifecycle rule, both account-level decisions. The field is copied to every tenant with the credentials, so one bucket serves a shared provider.

**Why Pouch never creates or activates a rule set:** there's one active per account and region, and it may route mail Pouch doesn't know about. Changing it is an admin's call, and leaving it out keeps `ses:SetActiveReceiptRuleSet` off Pouch's policy.

**Why Pouch's rules go first and stop the set:** SES runs every matching rule in order. A rule Pouch writes matches only a host Pouch routes, so nothing later has a claim to that mail, and an earlier catch-all that stops would swallow it.

**A virus verdict quarantines; the rest are reported.** A message SES flags as a virus keeps its metadata and verdicts and none of its content. Spam, SPF, DKIM and DMARC verdicts go on the message for the receiver to judge: Pouch can't know whether a receiver wants forwarded mail that fails DMARC.

**Revisit when** an account nears SES's 200 rules per rule set: one rule per domain is simple to add and drop, but it caps inbound domains per AWS account.

## Inbound download links are minted on read, never sent in a webhook

`GET /v1/inbound/:id` signs a 15-minute link for each attachment and the raw message. The `inbound.received` payload carries the same fields as null.

**Why:** a payload is stored, retried for hours and shown on the dashboard's delivery log. A bearer link in it outlives the read it was meant for. Same shape as an export's `download_url`.

Since #487 the objects are sealed, so the link points at `/download/<token>` on the app, HMAC-signed over the message, the part and the expiry, and the app decrypts on the way out. A presigned storage URL would hand over ciphertext. A stored payload's `text` and `html` are nulled when the inbound sweep purges the message.

## The inbound subdomain is per domain

`domains.inbound_subdomain`, `inbound` by default, one DNS label. Changing it drops the records on the old host and proposes the provider's records on the new one; on SES it moves the rule.

**Why:** addresses already handed out don't move. Scope's `<token>@intake.scope.example` is the case that asked for it.

## Bulk is a per-domain opt-in, off by default — not derived from the provider

#7 shipped bulk mode's mechanics (batches, lists, double opt-in, unsubscribes) gated only by the provider adapter's `capabilities.bulk` constant. `domains.bulk_allowed` (#246) adds a second gate: a boolean, default `false`, that an admin turns on per domain. A domain sends bulk only when both are true.

**Why off by default, not null meaning "follow the provider":** #7's original shape was a nullable column where null deferred to provider capability — today's behavior, no migration backfill needed. Turned off instead: every domain that can currently send bulk only because its provider happens to allow it — a transactional-only domain on SES included — stops being able to until someone decides it should. Nothing revisits that decision until there's a reason to.

**The provider fact always wins.** Turning `bulk_allowed` on for a domain whose provider can't do bulk (`capabilities.bulk: false`) is refused at the point of turning it on (`lib/domains/index.ts`'s `setBulkAllowed`), not silently accepted and failed at the next send. That's not a policy call an admin can override — it's whether the provider has the capability at all.

**Two reasons, kept apart.** `bulk_not_allowed`'s `detail.reason` is `provider_incapable` or `domain_disabled` — see `lib/bulk/allowed.ts`. They send an admin to different places: move the domain, or flip a switch. `lib/messages/bulk-detect.ts`'s own `bulk_not_allowed` (the fan-out guard on `POST /v1/emails`, unrelated to `bulk_allowed` — see "A compliance header only counts if the provider will carry it") carries the same `provider_incapable` reason for the one case it can throw, so a caller branching on `detail.reason` sees one vocabulary everywhere this code appears.

## Reputation standing is computed on read; only its last change is stored

Each domain and organization has one standing: healthy, watch, at risk or paused (`lib/reputation/standing.ts`). The dashboard computes it on every read from the same seven-day counts the reputation guard uses. `reputation_states` holds only the last standing the worker acted on and the last one owners were emailed about, so a change fires its webhook, activity row and email once, and a repeat can be throttled.

**The lines come from the reputation guard.** `lib/domains/guard.ts` owns the pause line and AWS's review and pause lines. Watch starts at half the pause line (1.25% bounce, 0.025% complaint) and at risk at 80% of it (2%, 0.04%), where 2% bounce is the usual industry ceiling. A rate also counts as past a line when the guard's one-window projection crosses it. A previous window under 50 resolved messages has no rate, so a rise needs volume on both sides. Below that floor, a bounce or complaint count at the guard's count line is at risk.

**Behavior signals raise watch or at risk and never pause.** Over the last 24 hours against the seven days before: volume at 5× the daily average is watch and 20× is at risk, from 200 messages to 50 recipients; first-time recipients at 50% is watch and 80% at risk, from 100 recipients; 10 sends refused as suppressed is watch and 50 at risk; a bounce on a domain verified in the last 14 days, under the rate floor, is watch. A domain with no sends in the baseline has no baseline to spike against. Refused sends are counted per domain per hour in `suppressed_rejections`, since a refusal leaves no message row. Fewer than 50 recipients is people already in touch, not a leaked key or a list. An at-risk alert names what it's about: "At risk of pausing" for rates, counts and provider findings, "On a blocklist" for a listing, which never pauses, and "Worth a look" for these signals alone.

**DMARC reports raise watch and never more.** The provider's own mail failing DMARC at 5% of at least 100 reported messages in 7 days is watch (see "DMARC reports come to one host the admin owns, one address per domain").

**Provider findings raise the organization's standing and never pause.** An open SES reputation finding on the organization's tenant is at risk when SES rates it high impact and watch otherwise. `provider_findings` keeps one row per tenant and finding type, opened and closed by the tenant status events (`lib/providers/tenant-status.ts`), since the activity log isn't a record to decide on. A tenant SES paused already suspends the organization with source `provider`, so it reads as paused.

**The organization's own standing is what alerts.** A paused domain makes the organization's displayed standing at risk, but only the organization's own findings (a suspension, or rates summed across two or more domains, skipping domains that carry their own rate finding) change its stored standing. Otherwise every domain alert would arrive twice.

**Email is loud and throttled per standing.** Owners get mail on entering at risk or paused, and on leaving paused. Re-entering the standing last emailed inside 24 hours sends nothing; a worse standing always sends. Admin push fires on entering at risk, since paused already pushes through the pause and suspension alerts. Each of the three is a notification type (`standing_at_risk`, `standing_paused`, `standing_resumed`), so an owner or the admin can turn it off; see "Owners are emailed by default, and each type is silenced on its own".

**Changed 2026-10-05 (#568):** the pause lines are settings now, and watch and at risk follow them as shares. See "Reputation thresholds only tighten".

## AWS's provider numbers are read, cached and shown; they raise standing only where Pouch can't see them

The health loop reads each non-tenant provider's `GetAccount` quota every pass, its CloudWatch `Reputation.BounceRate` and `Reputation.ComplaintRate` every `RATES_REFRESH_SECONDS` (15 minutes) and, on a shared provider, `ListRecommendations` once per `FINDINGS_SWEEP_SECONDS` (an hour), up to `FINDINGS_PAGES_PER_SWEEP` (20) pages. SES calls keep `PROBE_SPACING_MS` between them. Everything lands in Redis (`lib/providers/provider-metrics.ts`); the system view and standing read only the cache.

- **Quota:** admins get one push when the last 24 hours pass `QUOTA_WARN_SHARE` (80%) of `Max24HourSend`, and another only after usage drops back under it.
- **A denied CloudWatch read is a state, not an error.** It's cached as `denied`, asked again after `DENIED_RECHECK_SECONDS` (an hour), shown as "Needs cloudwatch:GetMetricData", and never touches the provider's health.
- **Standing:** AWS's rate for an ordinary provider raises its organization to watch or at risk at Pouch's own watch and at-risk lines, never paused. It's skipped for a metric when a domain on that provider, or the organization's summed rates, already has a finding for it, so the same bounces don't alert twice. Admins get one push per crossing of the at-risk line on any provider.
- **Tenants don't inherit the shared provider's rate.** It sums every tenant, so one organization's bounces would put thousands of others at risk for mail they didn't send. Their own reputation reaches them through tenant findings; the provider's reaches the admin.
- **The findings backstop only acts on a change.** Opening an already-open finding updates it silently, and a finding is closed by absence only when every page was read. The event path follows the same rule, so an SNS replay no longer logs or pushes twice.
- **Tenant counts are read on demand** when someone opens a reputation page, and cached for `TENANT_VOLUME_TTL_SECONDS` (an hour). A sweep across 10,000 tenants would cost more than the pages it serves.

**Revisit when** SES publishes per-tenant reputation rates, which would replace the counts and the provider-rate exclusion for tenants.

## Domain blocklists are Spamhaus DBL and ZRD, budgeted under the free DQS limit

`lib/blocklists/` checks each verified sending domain once a day, and each message's link hosts as it sends, against Spamhaus DBL and ZRD through DQS (`SPAMHAUS_DQS_KEY`). Without the key the checks are off and the settings page says so.

- **Lists:** DBL is the domain list mailbox providers act on; a listing is at risk. ZRD flags domains Spamhaus first saw in the last 24 hours; it's watch, since it lapses on its own. Both come with the same key and budget. SURBL and URIBL need their own licenses and query setup for anything hosted, so they're out.
- **Return codes** follow Spamhaus's DBL FAQ and DNSBL usage FAQ. Anything in `127.255.255.0/24`, or a code outside the documented set, is a check error and never a listing. Each sweep first queries `dbltest.com`; any answer but `127.0.1.2` marks the key as failing, pushes once, pauses every check and shows on the settings page.
- **Budget:** one Redis counter per UTC day. Link checks stop at 75,000 queries and the sweep at 90,000, under the free limit of 100,000, with one push per stop per day.
- **Links never slow a send.** The check runs beside the provider call, gives up after 500 ms, covers up to 10 hosts and caches each answer for an hour. The sending domain and the app's own host are skipped. Listings land on `messages.link_listings`, and any in the last 24 hours raise the sending domain's standing.
- **The host's resolver, not a public one.** Spamhaus refuses public resolvers, so `lib/domains/dns-check.ts`'s resolvers aren't reused.

**Revisit when** hosted sending needs it: the free DQS terms exclude commercial use, and at that volume per-send link checks should move to a sampled or post-send job on a commercial feed.

## Healthy is quiet; detail is one click away

The dashboard shows what's going out and whether it's running smoothly. A healthy domain or organization gets one chip and one line, never a banner or a wall of numbers. Watch and worse get a banner with one sentence and a link. Thresholds, both windows, trends, signals and reasons live on their own page (`/domains/:id/reputation`), not on the screens people pass through.

**Why:** a screen that shows everything all the time reads as trouble even when nothing is wrong, and hides the one thing that is. Loud is reserved for when something needs doing, and email stays loud either way.

## A provider callback's events apply in one transaction, not by derived idempotency keys

`receive` hands every event a callback parses to `applyEvents` (`lib/messages/events.ts`), which applies them in one transaction and posts webhooks and live updates only after it commits. A throw part-way rolls the batch back, so the provider's retry applies each event once. Each message row is locked for the rest of the transaction, and its webhook reports the row as that event left it.

**Why not a derived key:** Cloudflare falls back to the arrival time when an event has no `eventTimestamp`, so a hash that includes `occurredAt` can change on retry, and one that leaves it out merges two real deferrals into one.

**Why the lock time is fine:** every shipped provider parses at most one event per request, so the transaction is the same size it was per event. Tenant status stays outside it, since it reads SES mid-loop and answers 503 for redelivery.

**Revisit when** a provider sends large batches: split the transaction per message, or sort by message to avoid lock-order deadlocks.

## A shutdown hook is a drain by flag, and drains run together

`onShutdown(name, fn, { drain: true })` marks a hook that waits for in-flight work (`lib/lifecycle.ts`). On a signal, every drain runs at once with `SHUTDOWN_DRAIN_TIMEOUT_MS` (75 s). The remaining hooks then run one after another in reverse registration order with `SHUTDOWN_HOOK_TIMEOUT_MS` (8 s). Every worker loop and the SMTP listeners are drains; connections, the subscriber, the heartbeat and the health server aren't.

**Why a flag:** the budget used to follow a `:loop` name suffix, and only the send loop matched it. Webhook requests alone can take 10 s.

**Why together:** run in turn, the send loop kept claiming mail until the eleven loops before it had stopped, and the worst case was the sum of the budgets. Run together, it's the longest one. A loop that aborts fast, like exports since #348, returns early whatever its budget is.

**Why 75 s:** a provider call can take 60 s (`SEND_TIMEOUT_MS`), plus the writes after it. `stop_grace_period` on `mail-worker` is 135 s: 75 s of drains plus six teardown hooks at 8 s each, with room to spare. `mail-smtp` gets 105 s: its listeners drain, and three teardown hooks follow. Raise them together.

**Revisit when** a send can outlast the drain budget in practice. Past the drain budget, a send is recovered by the five-minute lock reclaim, which can send it twice.

## The app's shutdown hooks run inside Next's own exit

`instrumentation.ts` calls `deferSignalsToHost()` (`lib/lifecycle.ts`) so the app's hooks don't start on SIGTERM, then wraps `process.exit` once. Next's handler (`start-server.js`) stops accepting, waits for pending requests, then calls `process.exit(143)`; the wrapper runs `runShutdownNow` first and exits with the same code. A second exit call during shutdown passes straight through. The worker and SMTP processes keep their own signal listeners. A hook can set its own budget with `onShutdown(name, fn, { timeoutMs })`, and a second `runShutdownNow` waits on the shutdown already running. The app's one hook is the drain for password-reset mail (`app:auth-tasks`, 8 s).

**Why:** Next exits without waiting on anything of ours, and our own SIGTERM listener raced it: a hook that awaits started and never finished, with the server exiting 143. Starting the hooks early instead would run them while requests are still in flight. Hooking the exit gives the order stop accepting, finish requests, hooks, exit.

**Why not `NEXT_MANUAL_SIG_HANDLE`:** it hands Next's drain to us, and the request cut that follows is a lost send behind two replicas.

**Revisit when** Next gives instrumentation a shutdown hook, or its handler stops ending in `process.exit`. Either makes the wrapper unnecessary.

## A health check changing state pushes once, from the worker

`HealthWatchLoop` (`worker/health-watch.ts`) runs the registry every `WORKER_HEALTH_WATCH_INTERVAL_MS` (60 s) and calls `watchChecks` (`lib/health/watch.ts`). A check that starts failing pushes once, a recovery pushes once and a check that keeps its state pushes nothing. The last state of each check lives in Redis, with a process copy for when Redis is the failing check, and one replica runs a pass per interval.

**Why the worker:** the app is stateless and multi-instance, so a timer there would push once per instance. The worker already owns the slow loops.

**Why these rules:** a check seen for the first time pushes only if it's failing, so a restart into a healthy service is silent and a restart into an outage isn't. The state is written before the push, so a push that fails is logged and never repeated. The `worker` check is left out: it reads the heartbeat of the process running the watcher, and a Redis restart would make it flap for one beat interval.

**Not a duplicate:** the existing pushes cover provider quota, reputation and findings, and the email alert covers a provider backing off for 30 minutes. None fires when a registry check fails, so a down Postgres, Redis, storage bucket or provider in use had no alert.

**Revisit when** a check flaps often enough to be noise: require two failing passes before the first push.

## Job heartbeats are rows in Postgres, and a run that threw reads failing

Every worker loop records its runs in `job_heartbeats` (`lib/health/jobs.ts`): `IntervalLoop` and `SendLoop` write the start, then the finish with a fixed error sentence when the pass threw, and a long run (an export build) beats in between. A job reads `stale` past three of its own intervals (15 s at the least), `failing` inside that window when its last run threw, `never` with no row, otherwise `ok`. The system screen shows each loop's state, and `/healthz?detail` carries a non-critical `jobs` check with counts of each, so a stale or failing loop degrades the report and the health watcher pushes it.

**Why Postgres:** Redis holds nothing across a restart. Its last-seen record vanished with it, so an hourly loop read "never reported" for up to an hour after a Redis restart, and the unconfirmed-sends alert, which needs the marking loop to read alive, stayed off for as long. The row survives, and the state is judged against the database's clock.

**Why failing is new:** the Redis beat was written after every pass whether or not it threw, so a loop that threw on every tick read alive.

**Why one row per loop, not per worker:** the screen already read the freshest run across the fleet. The per-worker list is gone with the keys; the fleet card still counts workers from the process heartbeat, which stays in Redis because it expires on purpose.

**Why `jobs` is non-critical:** a failing blocklist or provider-health loop shouldn't answer 503 for a service that's still sending. A send loop that stops with mail queued already fails the critical `queue` check.

**Cost:** two small upserts per run. The 2-second loops (send, webhook, test mode) make about three writes a second between them.

**Revisit when** that write rate shows up in Postgres, then skip the start write for loops under 15 s. Or when one replica's loop dying behind another's healthy runs needs catching: key the row by loop and worker.

## The kit comes from a shadcn registry, and Pouch only sets tokens

uikit is served as a shadcn registry under `@uikit`. Pouch installs items with the shadcn CLI, owns its brand in `app/brand.css` and never edits a kit file. A fix goes to uikit by PR and comes back through the registry (`pnpm uikit`).

**Changed 2026-10-02:** this replaced `scripts/sync-uikit.mjs`, which copied the kit out of a uikit checkout. Pouch had edited 24 kit files by then, so the sync refused and `--force` would have deleted the work. The edits that were general went to uikit; the rest were pruning or comment rewrites and were dropped.

**Why:** a copy that's edited in place can't be updated, and every fix made only here is one the next app doesn't get. Tokens are the one thing a project legitimately changes, so they're the one thing it owns.

**Revisit when** uikit is published as a package with a build step, or the registry's per-file copies cost more than a version bump would.


## A domain's delivery time is read against its own earlier week, in one rule

`readDeliveryShift` (`lib/metrics/delivery-time.ts`) reads `domain_daily_stats` and is the only place the rule lives. The digest's "Needs a look" (`lib/mail/digest/metrics.ts`) and reputation's watch (`lib/reputation/standing.ts`) both take its answer.

**What it compares.** Each row's p90 covers the 7 days to its run, so today's row against yesterday's would compare two nearly identical windows. The baseline is the median p90 of the rows from 7 to 14 days back, whose windows end before today's begins. The digest reads as of the window's last instant, so a daily digest at 00:00 UTC reads the day's settled row, not one the hourly loop hasn't written.

**It fires when the p90 is both 3× its baseline and at least 30 seconds.** Either alone is wrong: 3× on a 2-second p90 is 6 seconds and nobody notices, and 30 seconds is ordinary on a domain that always takes 25. Three is the multiple `domain_volume` uses for a rise. Thirty seconds is where a password reset or sign-in code starts to feel broken. No industry line exists for either, so they're named constants, not settings, until a tenant needs to move them (see "Defaults follow convention").

**It stays silent without 100 delivered messages in today's window, and without 5 of the 8 baseline rows each having 100.** A p90 on fewer than 100 messages is set by its top ten, and a domain that sends a few a day would flap. This matches `domain_volume`'s shape (50 a day over 10 active days) at the week's grain: about 14 a day.

**Watch only, never at risk, never a pause.** Slow delivery is the signal before harm, usually a mailbox provider throttling. Nothing has bounced yet, and delivery time alone can't say the mailbox provider will refuse mail. The copy names what's slow, against what, and that bounces often follow.

**Limits.** The rule is silent until a domain has two weeks of rows; `domain_daily_stats` has no backfill, so a domain gets it that long after the rollup first ran on it. A 7-day p90 also blunts a spike that lasts hours: a slow afternoon on a busy domain registers the next day, not that evening. A true per-day p90 would sharpen both, and costs a different rollup.

**Revisit when** a domain's p90 swings on its own more than 3× between weeks, or when the rollup grows a per-day delivery column.

## A message's size is recorded at accept time, and unknown is null

`messages.body_bytes` and `messages.attachment_bytes` are written with the row by `acceptInternal` (`lib/messages/create.ts`) and the batch path (`lib/bulk/create.ts`). SMTP, replies, forwards and system mail reach the first.

**Why at accept:** provider cost and limits follow size, and once the retention sweep shreds the key the body can't be measured again. Nothing recomputes it.

**What each counts.** `body_bytes` is the UTF-8 bytes of the html and text as accepted: before the domain's layout, and including a text part generated from html. `attachment_bytes` is the decoded size the send's limit check already measures. A message with no attachments records `0`.

**Why nullable:** rows from before this have no size, and a default of `0` would read as an empty message. Both columns are `null` there and the API passes the null through. A backfill is possible only for the rows whose body hasn't been shredded, and each one needs a decrypt and a read from R2, so none runs.

**Limit.** `body_bytes` undercounts what the provider receives by the layout's frame and the MIME encoding. It's the size of what the caller sent.

**Revisit when** cost tracking (#551) needs the provider's wire size; that is a third number measured at send, not a change to these two.

## A resend creates a new linked message

`POST /v1/emails/:id/resend` and the dashboard's Resend build a request from the original's envelope and stored body and run it through `acceptResend` (`lib/messages/create.ts`). The copy is a new row with `resent_from` pointing at the original. The original is never re-queued.

**Why a new row.** Each send keeps its own status, events, warnings, sizes and provider id. Re-queuing the old row would overwrite the history that tells a caller what happened the first time.

**Why the accept path.** Suppression, domain verification, key scope, fan-out and provider limits have to hold at the time of the resend, not the time of the original.

**Idempotency** hashes the original's id rather than its content, so a replay answers before the body is read and still works after the body ages out.

**The body has to be readable.** A withheld, shredded or expired body refuses with `resend_not_allowed`, as does a bulk original whose recipient has unsubscribed from the domain since; storage not answering is `storage_unavailable`. The copy keeps the original's test mode.

**Revisit when** a caller needs to change something on the copy, such as a recipient. That's a new send with a body, not a resend.

## DMARC is recommended and read live, and only bulk needs it

Domain setup recommends a TXT at `_dmarc.<domain>` with `v=DMARC1; p=none;`, marked `required: false`, and reads the domain's DMARC record from DNS on a verify call and on `include=dmarc` (`lib/domains/dmarc.ts`). The recommended record is added when a domain is serialized, not stored, so domains that already exist get it and a record a provider supplied at that name wins.

**Why `p=none`.** It's the one policy that can't lose mail, and Gmail and Yahoo ask only that a bulk sender publishes a record, at any policy. The `rua` joins it once the admin sets up a report host (see "DMARC reports come to one host the admin owns, one address per domain").

**Why it never blocks verification.** Mail sends and delivers without DMARC; the provider decides a domain is verified, and DMARC isn't its call. `missing_records` stays the provider's answer for the same reason: a provider can't see the record, so listing it there would claim a check nobody made. `dmarc` carries it instead.

**Why bulk requires it.** `bulk_allowed` is the one switch that opens a path where Gmail and Yahoo's bulk-sender rule applies, and both reject mail that breaks it. The check runs when `bulk_allowed` is turned on, not at each send: a send-time check would put a DNS lookup on every batch and stop a domain that was already sending the day a record lapsed. Only a definite absence refuses (`missing`, `multiple`, `invalid`); a lookup that doesn't answer passes, so a resolver timeout never stops an admin. A record at `p=none` passes, since that's what the rule asks.

**Alignment.** Under relaxed alignment, DMARC's default, the MAIL FROM subdomain `mail.<domain>` aligns with the domain. Under `aspf=s` it doesn't, so SES's SPF stops aligning, and DKIM, which signs as the domain itself, carries DMARC alone. DMARC passes on either, so a default setup fails only when both sides do. The read derives each side from the records: DKIM from the name a selector record sits under, SPF from the names holding an SPF record. It can't see which domain a provider signs as; it assumes the selector's.

**The organizational domain** is the registrable domain from the public suffix list (`tldts`), so `mail.example.co.uk` falls back to `_dmarc.example.co.uk`. A subdomain's own record wins, and when the organizational domain's record governs, `sp` applies in place of `p`.

**Revisit when** a provider reports which domain it signs and sends as, which would replace the derivation.

## DMARC reports come to one host the admin owns, one address per domain

An admin sets a report host and the shared provider that receives it on Admin settings → Reputation (`lib/dmarc/host.ts`). Each domain gets an opaque token on it, minted on first read (`dmarc_domain_tokens`), and its recommended `_dmarc` record carries `rua=mailto:<token>@<host>` once the host's records check out. Mail to the host is parsed as an aggregate report for the token's domain and never reaches inbound, addresses or a webhook (`lib/dmarc/receive.ts`).

**Why the service's host, not the domain's inbound subdomain.** A domain's inbound needs a webhook, opens a provider route per domain and publishes an MX the customer has to add, all for mail the customer never reads. One host is one route and one set of records, set up once by the admin. The cost is RFC 7489 §7.1: a `rua` outside the domain's organizational domain needs the report host to authorize it, so the host publishes `*._report._dmarc.<host>` = `v=DMARC1`, which authorizes every domain at once. Receivers that skip the check send anyway.

**Why a token, not the domain name.** A domain name in the local part says which customers the install serves to anyone reading DNS, and the same name can exist in two organizations. A token names one domain row and nothing else. Mail to a token no domain holds is dropped and logged.

**Why adding the `rua` is the customer's opt-in.** Reports only arrive once the domain publishes the address, so nothing is collected about a domain that didn't. A domain already publishing a record gets that record back with the address added to its `rua`, every other tag kept (`withReportUri` in `lib/domains/dmarc.ts`), and a `no_report_address` note. An owner can turn reports off for the organization on Settings → Sending (`organizations.dmarc_reports_enabled`, in the activity log); the `rua` then drops out of the recommended record and the panel goes away. The `dmarc_reports` feature does the same for the install and also drops report mail on the host.

**Which providers can take the host.** One whose adapter routes received mail through its API (`inbound.open` and `inbound.received`), which today is SES. The route opens under `dmarc-reports` in place of a domain id, so SES's receipt rule, bucket prefix and event topic work unchanged, and `receiveProviderMail` hands that route id to DMARC ingest. Only the provider the setting names may deliver report mail, and a message SES scans as a virus, spam or a DMARC failure is treated as forged.

**Reading a report is defensive.** Zip, gzip or plain XML, detected by leading bytes. Attachments past 10 MB and XML past 32 MB expanded are refused, by zlib's `maxOutputLength` rather than the sizes an archive claims. XML is checked for well-formedness before it's read, a DOCTYPE is refused outright, and a report needs its metadata, a period no longer than 31 days that doesn't end in the future, and at most 20,000 rows. A report about another domain, or with no rows whose header From is this domain, isn't stored. A reporter's report id is stored once per domain.

**Who sent each row comes from the domain's own records.** The provider publishes a DKIM selector under `._domainkey.` and, for SES and Mailpace, an envelope host; a row carrying either is the provider's, or forwarded when neither passed and SPF failed. Nothing hard-codes a provider's addresses. A row without them that passes DMARC is another sender the domain authorizes, such as its own mail service; one with a broken aligned DKIM signature is forwarded; the rest are unauthenticated. The apex's SPF is never used, since every sender the domain authorizes shares it.

**What reports change.** The provider's own mail failing DMARC at 5% or more of at least 100 messages in 7 days of reports is a watch finding (`dmarc_failing`): under `p=none` it's still delivered, and a stricter policy would junk it. Unauthenticated mail is the `domain_spoofed` observation, never standing: someone else's mail isn't the domain's sending behavior. The Reputation page leads with a verdict, with the summary and sources and their SPF, DKIM and DMARC rates beneath. `GET /v1/domains/:id/dmarc_reports` lists them. All of it reads stored reports whatever the host's state, so a lapsed host record hides nothing; the panel adds a line that new reports aren't arriving. Only the organization's switch hides them.

**The panel's verdict uses the same lines, over the same 7 days.** At risk at `dmarc_failing`'s line, watch when any of the provider's mail fails or `domain_spoofed` would fire, healthy otherwise (`dmarcVerdict` in `lib/dmarc/read.ts`). It borrows standing's words and chip but isn't standing: at risk there means the provider's mail would suffer under a stricter policy, and raising the finding to match would send the "at risk of pausing" alert for something that can't pause the domain. Spoofing waits for the observation's 10 messages, not one, so a stray forwarder doesn't turn the panel yellow.

**`p=quarantine` is advice, offered once it's earned.** The panel shows the domain's own record with only `p` changed once the live record is `p=none` and reports have read healthy for 30 days in a row. A day is the UTC day a report's period ends, judged by the verdict alone; a day without reports or a day that isn't healthy restarts the count, and the latest day may trail today by 2, since reports arrive a day late. A domain that follows its organizational domain's record gets no suggestion: the change would land on every subdomain.

**Owners get one email when a domain first qualifies.** The reputation guard's pass checks each organization it touches (`lib/dmarc/ready.ts`) and claims the send on `dmarc_domain_tokens.policy_ready_notified_at` before mailing, so it goes once; the live policy moving past none clears it, so a domain that goes back to `p=none` and qualifies again gets another. It's a plain next step with the record and a link to the Reputation page, logged as `domain.dmarc_policy.recommended`, and the organization's switch silences it. It's advice with a single action, so it's sent once. It's the `dmarc_policy_ready` notification type, so an owner or the admin can turn it off, and silenced counts as sent: the claim stays until the policy moves.

**Retention follows `body_retention_days`.** It's the organization's one retention setting, and reports name source addresses, not recipients. The retention loop deletes reports past it, rows and all.

**No bootstrap variable.** Setting the host opens a route at the provider, which needs the app up and a shared provider configured, and no other service setting is seeded from the environment. An admin sets it once on Admin settings → Reputation.

**Revisit when** a provider without API routing needs to receive reports (Mailpace's inbound is a console step per domain), or when report volume makes per-row storage expensive, which would roll rows up per source and day.

## Observations come from send metadata and are muted per tag or key

An observation is a pattern in what Pouch records about each send: recipients, tags, key, time, whether it's sensitive. Never a body. `account_targeted` fires when one address gets 10 or more sensitive messages in 24 hours; `tag_quiet` when a tag that sent every day of its 14-day baseline sends nothing for a day, by the rule `lib/metrics/volume.ts` uses for a domain. A tag whose every baseline domain sent nothing in the last day is left out, since that domain's own condition already says it. `domain_spoofed` reads DMARC reports rather than sends: 10 or more unauthenticated messages as a domain in 7 days. It has no tag or key to mute by, so it's on or off.

**One file each.** A file in `lib/observations/` exports one or more observations: a key, a name, a description, a tone, what can mute it, `evaluate` returning findings with subjects and numbers, and a wording for the overview and for the digest. Add a file to add an observation; delete it to remove one. `scripts/gen-observations.mjs` writes `registry.generated.ts` from the folder on `dev` and `build`, and `pnpm test` and a unit test fail when the committed file is stale. Files starting with `_` are the plumbing, not observations. One runner (`_runner.ts`) loads the organization's mutes, runs each observation that's on and drops what a mute covers; the overview conditions and the digest each take its results through one hook.

**"May", never "is".** The wording says what Pouch saw and that someone may be targeting the account. Sensitive mail in bulk is also what a login page under a bug or a load test looks like.

**Muted per tag or key, or off.** `observation_mutes` holds a tag or a key per row, or neither for "off across the organization". The key column is text, so a new observation needs no migration. On is the default with no row, so a new file is live everywhere on deploy. A row whose observation no file defines is ignored and kept, so restoring the file restores its settings. Owners change them on Settings → Sending, and each change is in the activity log. The dashboard is the only surface: an observation is Pouch's reading of the metadata, which the API already serves.

**Never pushed, and emailed to owners.** Observations reach the overview, the admin's digest and, since #572, owners' email. Push is for the service itself, never for a pattern in a tenant's mail. The digest line counts addresses and never names one.

**Superseded in part by** "Owners are emailed by default, and each type is silenced on its own": this entry said observations never reach anyone outside the dashboard and the digest.

**Cost.** `tag_quiet` reads 15 days of live tagged mail per organization on every overview load, on `messages_live_tagged_idx` (organization and creation time, partial on live mail with tags). `account_targeted` rides `messages_withheld_idx`. The digest runs both for each organization with live mail in the hourly rollup's last 15 days or sensitive mail in the last day.

**The built-in conditions stay where they are.** Backlog, held, domain volume and the rest are still in `lib/metrics/conditions.ts`. They could move to observation files later.

**Revisit when** the tag read shows up in overview latency: roll per-tag daily counts up with the hourly stats.

## Optional features are flags an admin turns off, and the core has none

Bulk, lists, inbound, addresses, observations and MCP each have a flag (#562). Domains, messages, keys, webhooks and suppressions don't. Every flag is on by default, and a feature that's off is still in the code: nothing is built to be deleted.

**One registry for install settings.** A flag is a boolean entry in `lib/settings/registry.ts`, beside integer and enum entries, each with its section, label, default, environment variable, bounds or options, `dependsOn` and `configOnly`. `resolveSettings` takes the environment, then `pouch.yml` (see "Settings can be pinned in pouch.yml, under the environment"), then `service_settings.settings`, then the default. Boot refuses a value from the environment or the file that doesn't fit the entry's type or bounds, and a stored one that stops fitting is skipped. A feature depending on another, lists on bulk and addresses on inbound, is off while that one is. Admins change entries in Admin settings, one tab per area (`SETTING_PAGES`), since a setting is policy, not diagnostics. General keeps system mail, the default provider and the config file; Monitoring sits on Reputation beside the DMARC report host. A value the environment sets shows there and can't change. Every change is in the service's activity log.

**Stored as one jsonb column.** `service_settings` is already the install's one row, so `settings` is a jsonb map by entry key and one read resolves every entry. A new entry needs no migration, and the registry, not the column, does the typing. A key/value table would need the same parsing on a text column and buys nothing for one row. A stored value an entry no longer accepts, after its bounds tighten, falls back to the default rather than failing.

**One check per boundary.** API routes are matched by path in `withAuthenticatedKey` (`lib/api/with-key.ts`) and answer `403 feature_disabled` naming the feature. MCP tools call those routes, so they answer the same, and `/mcp` itself is a path in the table. A worker loop declares its feature on `IntervalLoop`, which skips the pass and keeps the heartbeat. Observations stop in `runObservations`. A dashboard screen's layout answers 404 and the nav drops it, and its server actions go through `featureAction` (`lib/dashboard/feature-action.ts`), which refuses the same way. The check isn't in the `lib/` capabilities those actions call, because the unsubscribe and confirm paths and the worker call them too and have to stay open. Two fields on core routes check lists themselves: `subscribe` on a send and `list` on a batch.

**What stays on.** Unsubscribe and confirm links, and `POST /v1/lists/:id/unsubscribe`: withdrawing consent can't depend on a switch. The inbound and export sweeps, so a feature that's off still keeps its retention promise. Mail already queued, a bulk batch included, still sends. SMTP submission is core, so it checks nothing.

**Inbound that arrives while it's off is accepted and dropped.** Refusing the callback wouldn't bounce anything, since the provider already took the mail, and would only make it retry. On SES the provider's copy stays in the bucket for its lifecycle rule, so mail from the last week can be replayed with `scripts/replay-inbound.ts` once inbound is back on. Mail to an address while addresses are off is dropped the way an expired address's is, never handed to the domain's webhook.

**Exports have no flag.** "The record is yours" in `product/brief.md` makes export a button, not a support request, and `/v1/exports` is the way out `leaving.md` describes. A switch that closes it would contradict both.

**Data stays.** Turning a feature off hides and refuses; it deletes nothing. Its rows are there when it comes back on.

**Revisit when** an organization needs its own switch, which starts with DMARC reports (#298). That's a per-organization column beside these, not a change to them. Reputation thresholds are expected to move onto the registry as entries.

## The body retention ceiling is an admin setting, and it has a hard bound

`body_retention_max_days` (#564) is an integer entry in the settings registry: `BODY_RETENTION_MAX_DAYS`, then Admin settings → Retention, then 365. It runs from 7 to 730. An organization sets `body_retention_days` from 7 to the ceiling, checked against the live value in `updateOrganization` (`lib/organizations/index.ts`); the request schema holds only the hard bound.

**Lowering it never rewrites an organization.** `retentionDaysFor` and the retention sweep use the smaller of the organization's value and the ceiling, so raising the ceiling again restores what the organization chose. The organization's settings screen says when the admin capped it, and `GET /v1/organization` carries `body_retention_max_days`.

**Why 730.** "Never" has to stay impossible, and the bucket's lifecycle rule has to sit above the largest value the ceiling can take, so it needs a fixed number. Two years is twice the old ceiling and still a window someone can reason about.

**The bucket's rule is read, not trusted.** A rule that expires bodies at or under the ceiling deletes objects whose keys still exist, and the dashboard would call them retained. `lib/storage/lifecycle.ts` reads the private bucket's lifecycle configuration over the S3 API, which R2 serves, and takes the soonest enabled rule reaching the bodies prefix; a tag filter never matches, since bodies carry no tags. A ceiling at or past that rule is refused with the rule's age in the message. When the bucket won't say, usually a token scoped to objects, the change is allowed and Admin settings warns. The `body-lifecycle` health check catches the rule changing later: degraded when no rule expires bodies or one does at or under the ceiling, passing when it can't be read, so the worker's watch pushes once per change. Admin → Status shows the rule beside the ceiling, `unknown` when it can't be read. Each process reads the rule at most once a minute.

**Withheld and sensitive mail is untouched.** Its key is shredded once it leaves the queue, whatever the ceiling.

**Revisit when** an admin needs more than two years, which is a compliance archive and belongs in an export, not in live bodies.

## Inbound mail and the activity log are kept for windows the admin sets

#566 puts three entries in the Retention section beside the body ceiling.

**Inbound has a ceiling, like bodies.** `inbound_retention_max_days` runs from 1 to 365, 30 by default, which was the hard-coded maximum. A domain's `retention_days` is checked against the live value in `updateInboundSettings` (`lib/inbound/manage.ts`); the request schema and the database constraint hold only the hard bound. Lowering it never rewrites a domain. Ingest stamps `expires_at` with the smaller of the two, and the inbound sweep purges a row past its `expires_at` or past the ceiling from `received_at`, so mail already stored goes at the lower ceiling too. 365 because inbound mail is held for a webhook to pick up; a year is past any pickup and short of an archive.

**The bucket's rule is checked, but not required.** The sweep deletes inbound objects itself, so unlike bodies nothing needs a rule under `inbound/`, and no rule passes. A rule that reaches `inbound/` at or under the ceiling would delete mail the API still lists, so it's refused the way the body ceiling is, and the `inbound-lifecycle` health check degrades when one drops there later. A bucket-wide rule counts: it reaches both prefixes.

**The activity log is two windows, not one per action.** Eighty actions each with a number is a form nobody fills in, and the taxonomy already sorts them into setup changes and routine events. `activity_retention_days` keeps setup changes, 365 to 1825 days, 730 by default. `activity_churn_retention_days` keeps routine events, 7 to 730, 90 by default. Each action's class is `retention` on its taxonomy entry.

**Security events have floors.** Key, member, provider credential, webhook secret, emulation and admin setting changes are setup changes, and the setup window doesn't go under a year, so a yearly access review always has the record. Sign-ins, failed sign-ins, resets and link requests follow the routine window but never under 90 days, so lowering it to shed list churn doesn't erase who signed in last quarter. Raising the routine window keeps sign-ins' hashed client address longer too; that's the admin's call.

**What isn't a setting.** Organizations created, deleted and suspended, and admins granted and revoked, are kept indefinitely. They're the install's own record of who it served and who ran it.

**Revisit when** an admin needs one action kept apart from its class, which is a third class, not a number per action.

## Sending limits are settings, and the size limit only lowers

#567 adds two entries to the Sending section and two to Receiving.

**`max_message_mb` caps a message, not a request.** The body and decoded attachments together can't pass it, checked at accept in `createMessage` beside the provider's own attachment limit, so the smaller wins. It runs from 1 to 30 MB, and 30 is the default: Mailpace takes 30 MB in total and SES 40 MB with base64 counted, so nothing larger reaches a provider. Like the reputation lines, the default is also the highest value, and a higher one is refused. `MAX_BODY_BYTES` stays a fixed 30 MB transport cap on JSON request bodies: it guards every route and the webhook receivers from being made to buffer, and a batch carries many messages in one body, so it isn't a message size and isn't a setting. `SMTP_MAX_MESSAGE_BYTES` stays the SMTP equivalent.

**`key_rate_limit_default` is read when a key is created.** `createApiKey` takes it when the request names no `rate_limit`, so the seed, admin keys and the dashboard all follow it. Changing it never rewrites a key: each key stores its own number. The keys screen shows it as the form's default.

**Address defaults sit with addresses.** `address_limit_default` (500) and `address_daily_message_limit_default` (100) are in Receiving beside the addresses feature they depend on, not in Sending: they cap mail an address receives. The organization columns became nullable, null following the default, and migration 0085 moved every row still at 500 or 100 to null. A row at the old default and one an admin set to the same number can't be told apart, and both read the same either way.

**Revisit when** a provider Pouch supports takes more than 30 MB, which moves the hard bound, or a key needs a default per organization.

## An organization's address limits override the install's in two nullable columns

#570 lets an admin raise or lower one organization's address count and daily message limit, in Admin settings → Organizations ("Address limits" on the row) or `PATCH /v1/admin/organizations/:id`. Both call `setAddressLimits` (`lib/providers/admin.ts`), which records `settings.address_limits.changed` on the organization and the service, and records nothing when the values didn't change.

**Columns, not jsonb.** `organizations.address_limit` and `address_daily_message_limit` already existed, typed and read under the row lock that counts active addresses. Null follows the install's default and a number is the organization's own, so `effectiveAddressLimits` (`lib/addresses/limits.ts`) is one `??` per limit. A jsonb of overrides would trade the column types for parsing and buy nothing for two numbers.

**Null is the way back.** A blank field on the screen, or `null` on the route, clears the override, so a later change to the default reaches the organization again. Reads carry the limit in force; the admin route also carries `address_limit_override` and `address_daily_message_limit_override`, and the screen lists the organizations with their own.

**0 is allowed on an organization, not on the default.** Zero active addresses shuts one organization out of addresses while the rest keep them. Install-wide, the addresses feature flag does that.

**Revisit when** an organization needs any other limit of its own, which is when the overrides become a table.

## Reputation thresholds only tighten

`stall_bounce_percent`, `stall_complaint_percent`, `stall_bounce_count` and `stall_count_volume_floor` (#568) are registry entries in a Reputation section: the environment, then Admin settings → Reputation, then the default. Each default is also its highest value: 2.5% bounce, 0.05% complaint, 3 bounces, 10 resolved messages. Lower is tighter for all four. A higher value is refused in the dashboard, and at boot from the environment or `pouch.yml`.

**Why only tighten.** The defaults sit at half SES's review line, so the guard holds a domain before AWS looks at the account. A looser line moves that point toward the provider's own, and on a shared provider the cost lands on every organization on it, not only the install that loosened it. A tighter line costs held mail, which waits and sends on release.

**One reader.** `readStallLines` (`lib/domains/stall.ts`) resolves the entries once into `StallLines`, and everything that measures a rate takes them: the domain and organization pauses, the provider identity rollup, standing, the provider rate alert, the reputation and system bars, the overview and the digest. Watch and at risk stay shares of the pause line, so they follow it.

**What isn't a setting.**
- **SES's review and pause lines.** They're the provider's policy, shown so an admin knows where AWS acts. Nothing in Pouch acts on them, and a changed number would misstate AWS.
- **The complaint count.** It's 1, the least a count can be.
- **The watch and at-risk shares.** They already follow the pause line.
- **The 7-day window and the 50-message rate floor.** Neither has a tighter direction: a longer window buries a spike, and a lower floor trades counts for noisy rates.

**Floors.** 0.5% bounce, 0.01% complaint, 1 bounce and 1 message. Lower than that, ordinary list churn pauses a domain.

**Revisit when** a provider Pouch supports reviews senders below these defaults, which makes the default the wrong ceiling for it.

## Access is three settings: sign-in methods, session length and who creates organizations

#565 puts them on the settings registry, in Admin settings → Access. Every change is in the service's activity log.

**A method that's off is refused at its Better Auth endpoint, not only hidden.** `signInMethodsGuard` (`lib/auth/sign-in-methods.ts`) is a before hook on the method's paths: `/sign-in/email`, `/request-password-reset` and `/reset-password` for the password, the authentication and registration paths for a passkey, and the request and verify paths for a link. It answers `403 SIGN_IN_METHOD_DISABLED`, over HTTP and through `auth.api`, so a link sent before the switch stops working. The rate limits on link and reset requests sit in the route handler, so an `auth.api` call skips them; nothing makes one. /login, `/forgot-password`, `/reset-password` and `/login/link` drop what's off, and user settings stops offering "Add passkey" while passkeys are off.

**Nobody locks the install.** One method always stays on: turning off the last is refused, and the environment turning off all three leaves the password on. Turning one off is also refused when it would leave an admin with no way in, which is a password or passkey that stays on, or links with system mail working; the message names them. Links alone without system mail would let nobody in, so the password comes back on until mail works. A member can be left with no way in, and Admin settings says how many before the switch: an admin turning the method back on is their way back. `pnpm reset:admin` turns password sign-in back on when it's off.

**An invitation accepted while passwords are off sets none.** `redeemInvitation` creates the account with no credential and `signInInvitedAccount` (`lib/auth/invitation-session.ts`) starts its session, since the redeemed invitation is the credential. That endpoint is `SERVER_ONLY`, so the router never serves it. While passkeys are on, the accept screen then offers one, skippable only while sign-in links work.

**Session length is read at start.** Better Auth fixes `expiresIn` when its instance is built: the session row's expiry, the refresh and the cookie's `Max-Age` all come from it. `register()` reads `session_days` into the process (`lib/auth/session-length.ts`) before anything builds the instance, so a change waits for a restart, and Admin settings says so and shows what's running until then. 1 to 90 days, 7 by default, which was the hard-coded value. A session lasts that long without use; each day of use pushes it out. One day is the floor because shorter needs a different refresh rule, and 90 is the ceiling because the dashboard mints keys and moves domains, and a device unused for three months shouldn't still hold a session.

**Who creates organizations: closed, owners or open.** Open, the default, is anyone signed in, which is what every install did before. Owners adds people who own an organization to the admins. It isn't called invite: with public sign-up off every account already came from an invitation, so an invite mode would be open by another name. Closed is admins only. Admins always can, from Admin settings → Organizations and the admin API, which `organizationCreationRefusal` (`lib/organizations/index.ts`) doesn't gate. The dashboard's "Add organization" and /start follow it, and `createOrganizationAction` checks it again. Public sign-up stays off whatever this says ("Public signups stay off until per-organization caps exist").

**Revisit when** sessions need a length under a day, or creating an organization needs approval rather than a yes or no.

## Settings can be pinned in pouch.yml, under the environment

A YAML file pins settings registry entries (#571). Resolution is the entry's environment variable, then the file, then `service_settings.settings`, then the default, in `resolveSettings`. `lib/config-file.ts` reads `CONFIG_FILE` or a default name and knows nothing else, so starter-app copies it with its own name. `lib/settings/file.ts` checks the keys against the registry.

**Flat keys, the registry's own.** `stall_bounce_percent: 1.5`, not `reputation: { bounce_percent: 1.5 }`. The keys are already unique, and they're what `setSetting`, the activity log and `service_settings.settings` use, so one name means one thing everywhere. Sections are dashboard grouping and they move: nesting by section would make regrouping an entry a breaking change to every admin's file. The export writes a comment per section, so the file still reads in groups.

**The environment wins over the file.** A variable is the override an admin reaches for in an incident: set it on the host, restart, and it holds without editing a mounted file. The file is the reviewed record of an install underneath it. Boot warns about each variable that overrides the file, and the dashboard names whichever source locked a value. The first cut put the file on top, as Vardo does; that made an incident override a file edit.

**Checked at boot, read once.** `checkBootConfig` checks the registry variables and loads the file in the app, the worker and SMTP, all of which read settings. An unknown key, a value outside its entry's type or bounds, an empty value, malformed YAML, a directory where the file should be, or a `CONFIG_FILE` naming a missing file stops the process, listing every problem by key. A missing file at the default path is fine. The environment gets the same check: a registry variable that's set and doesn't parse stops the process, naming the variable, through the same `settingValueProblem` (`lib/settings/registry.ts`). Before #571 a bad variable was skipped silently and the dashboard value or the default ran instead. Like the environment, the file changes on a restart.

**Secrets stay in the environment, with no `pouch.secrets.yml`.** No registry entry is a secret, and each secret Pouch reads is a variable `lib/config.ts` checks at boot. A secrets file would be a second env file with its own permissions to get right, beside the env files and secret stores Docker and deploy platforms already have. A key like `ENCRYPTION_KEY` in `pouch.yml` fails boot, saying secrets stay in the environment.

**Export sets what differs from the default.** Admin settings → General → Export settings writes each entry's own value, before what it depends on, as a set line when it differs from the default and a commented-out line when it doesn't. Dropped in as `pouch.yml`, it pins what an admin changed and leaves the rest to the dashboard, while still listing every key. It round-trips through the loader to the same resolved values.

**Revisit when** a registry entry needs a secret, which is when a `pouch.secrets.yml` at 0600 earns its place, or when an admin needs a change without a restart.

## Owners are emailed by default, and each type is silenced on its own

Email is the channel; the dashboard is where people dig in. Most owners won't watch the dashboard, so anything worth knowing is mailed by default, and whoever gets it can turn it off.

**One registry.** `lib/notifications/registry.ts` lists every type: its audience (owners), its default (on), its throttle and its template. Today that's standing at risk, paused and resumed, a targeted account, a tag gone quiet, someone sending as a domain, slow delivery and a domain ready for `p=quarantine`. `sendNotification` (`lib/notifications/send.ts`) sends any of them. Every mail's footer links to `/user/settings#notifications`, and every send that reaches someone writes `notification.emailed` to the organization's activity.

**What decides, in order.** The organization's observation mutes, by tag, by key or off, drop a finding before it's a notification. Then the admin's switch: one boolean registry entry per type in the Notifications section (`notification_<type>`, `NOTIFICATION_<TYPE>`), so a type can be off for the whole install; the observation types depend on the observations feature. Then each owner's own choice. Then the throttle. Nothing is claimed while every owner has a type off, so turning it back on mails while the condition still holds.

**Choices live on the person, in user settings.** `notification_preferences` keeps one row per user and type, only where it differs from the default, with the type as text, so a new type needs no migration. Owners choose once for every organization they own, beside the digest preferences, because the choice is about what reaches their inbox; an organization that wants a type gone for everyone has its observation mutes. The table has no `organization_id`, like `digest_preferences`: a person's choice isn't an organization's row.

**Throttled per organization, type and subject, not per recipient.** `notification_sends` holds when each subject was last mailed and whether it has cleared since. A subject sends when it's new, or when it cleared and its window has passed: 24 hours for a targeted account and a quiet tag, 7 days for spoofing and slow delivery, which read 7-day windows. Every owner gets the same mail at the same moment, so one claim per subject is enough and keeps two workers from both sending. A send that reaches nobody gives the claim back. Standing and DMARC keep the claims they already had, on `reputation_states` and `dmarc_domain_tokens`, with the same behavior as before.

**Subjects.** A targeted account is one subject per organization, so an attack across many addresses is one mail; the mail counts addresses and never names one, since admins read it in Admin. A quiet tag's subject is the tag; spoofing's and slow delivery's is the domain.

**Where it runs.** Slow delivery is read with standing in `checkReputation`. Observations run in the reputation guard's pass for each organization it touches, at most once per `WORKER_STALL_GUARD_RECHECK_MS` per worker, which costs one overview's reads per organization every 5 minutes.

**Revisit when** several tags going quiet at once mails once per tag often enough to be noise: group a pass's findings of one type into one mail.

## System mail belongs to the service, and the organization holding its domain only carries it

System mail is stored with a null organization (#579), through `acceptServiceMessage` (`lib/messages/create.ts`). Before, it was logged in the organization holding the system from domain, so that organization's members could read every other organization's owner mail: recipients, subjects, bodies and the bounces on them.

**Why null, not a flag.** Every organization-scoped read filters on the organization, so a null row is missing from all of them with nothing to remember: the log, the API, MCP, the export and search. A flag would need every read to exclude it, and one forgotten `where` leaks. That's the opposite failure from the one "Why not a `system` flag on `messages`" guards against, and it's the worse one. Marking it sensitive wasn't enough either, since subjects and recipients would still show.

**The carrier still carries it.** The domain names the organization: its provider sends, its suspension and its domain's pause hold the queue, and the Feedback-ID names it. The domain's reputation guard, standing and suspension guard count system mail on it (`lib/stats/outcomes.ts`), because the provider sees those sends and a bounce costs that domain's reputation. The organization's own numbers, the dashboard, stats and the overview, don't.

**What follows from a bounce.** A bounce or complaint suppresses the address on the system mail list, under a null organization, and touches no recipient history. Admin settings → Status → System mail lists the mail and that list, and an admin removes an address there. No event on it fires a webhook or a live update.

**Retention.** The default body window under the ceiling. Withheld mail is shredded once it sends, as before.

**Deleting the carrier.** It's refused while it holds the system from domain. Once the address moves, deleting the organization takes system mail sent from its domains too, since `messages.domain_id` holds the domain in place.

**Deleting one domain.** System mail doesn't hold a domain the way the organization's own log does: the owner can't see it, so "the log is the record" isn't theirs to keep. `domainDeleteBlock` refuses while the system from address names the domain or system mail on it is still queued or deferred. Otherwise the delete takes the sent system mail with it (`dropServiceMail`). An unset address falls back to the next verified domain on its own, so it doesn't hold one.

**Existing mail.** Migration `0086` moves rows with no API key, no batch, a system tag and a system sender's idempotency prefix, with their events and the suppressions they caused, and drops recipient history the carrier only had from them. It drops the carrier's hourly cells for the hours system mail sat in and touches its own mail there, so the next rollup redoes those hours and nothing else. Emptying the rollup would have made the next run refill 190 days of every organization in one transaction. Search needs `scripts/search-reindex.ts --fresh` once.

**Revisit when** an organization should see its own owners' notifications in its log. Then they're a copy the organization holds, never the service's row.

## Notification timing is three settings, and the standing window is the standing types' throttle

#569 puts three numbers on the settings registry, in the Notifications section, each read on every pass through `readSetting`.

- **`digest_hour`**, 0 to 23 UTC, 0 by default. The hour admins' digests send. The digest loop still ticks hourly; that tick is plumbing (`WORKER_DIGEST_INTERVAL_MS`), not a cadence, and each admin already picks daily, weekly or monthly. Every value is valid: the window stays the UTC day, week or month before, whatever hour it lands.
- **`standing_alert_repeat_hours`**, 1 to 168, 24 by default, was `ALERT_REPEAT_MS`. How long owners aren't emailed again about a standing they were just emailed about; a worse standing always emails, and the admin's at-risk push follows the same decision. An hour is the floor because standing is checked every few minutes, and a standing that flaps would otherwise mail on every pass. A week is the ceiling, the longest window any notification reads, so a standing that comes back next week still emails.
- **`provider_backoff_alert_minutes`**, 15 to 1,440, 30 by default, was `WORKER_BACKING_OFF_ALERT_MS`. How long a provider backs off with no successful send before admins get an alert. The default is the ceiling on a single backoff (`MAX_BACKOFF_MS`) and double SES's longest single ask, so it fires once the provider fails to recover through more than one. 15, SES's longest ask, is the floor: below it, one throttle response alerts. A day is the ceiling: past it, mail has waited a day before anyone hears.

**No second knob.** The standing types' throttle in `lib/notifications/registry.ts` is `caller`: the registry holds no number for it, and `standing_alert_repeat_hours` is that number. The `until_clear` windows (24 hours, 7 days) stay code: each matches the window its finding reads, so a setting would let the throttle disagree with the data behind it.

**`WORKER_BACKING_OFF_ALERT_MS` is gone.** It was milliseconds, read by the worker only, and the registry entry is minutes. A worker that still has it set boots with a warning naming `PROVIDER_BACKOFF_ALERT_MINUTES` (`RETIRED_VARS` in `lib/config.ts`).

**Revisit when** a digest needs a day of the week or month other than Monday and the 1st, or an admin needs a `until_clear` window apart from its reading window.

## Send throughput comes from concurrency, not SES's bulk API

SES counts its send rate and daily quota per recipient, not per call (docs.aws.amazon.com/ses/latest/dg/quotas.html), so `SendBulkEmail` saves HTTP requests and nothing else. It also takes only an SES template, beside Pouch's own MIME with layouts, per-recipient unsubscribe headers and attachments. #247 closed on that.

`pnpm test:load` (`tests/load/send-throughput.test.ts`) accepts and sends through the real paths against the mock provider at a set latency. On a laptop with 120ms of provider latency and a 10-connection pool, one worker sent 51/s at concurrency 8, 191/s at 32 and 397/s at 64; one process accepted 290 to 460/s. Pouch adds about 45ms a send.

**Defaults:** `WORKER_CONCURRENCY` 32 and provider concurrency 16, up from 8 and 4, which held a provider near 24/s whatever SES allowed. Migration 0087 moves rows still at 4. The send-rate limiter still holds each provider to the rate SES reports, so a higher ceiling never outruns the account.

**Batch values are escaped in the html part.** `{{name}}` fills the html part through `renderHtmlTemplate` (`lib/bulk/template.ts`), so a list member's attribute reads as text instead of becoming markup or breaking out of an attribute. The subject and the text part take values as written. A text part generated from the html decodes them back.

**Batches accept in chunks.** `createBatch` (`lib/bulk/create.ts`) checks domain unsubscribes in one query, writes bodies 16 at a time and inserts messages and their queued events 250 per statement, still inside the request. A 5,000-recipient batch went from about 53 seconds to 3.9; before, a large list ran long enough for a proxy or client to time out mid-batch.

**Webhooks deliver from a rolling pool.** The webhook loop sent one batch of 20 per 2-second pass, each batch waiting on its slowest endpoint: 9 deliveries a second at 150ms an endpoint. `rollingPass` (`lib/worker/rolling.ts`) keeps `WORKER_WEBHOOK_BATCH` (now 50) in flight, claiming one as each finishes, stops claiming 4 seconds in so the heartbeat stays inside its stale window, and starts the next pass at once while deliveries are still due: 192 a second. The send loop keeps its own version, which also holds per-provider slots and rate permits. Sweeps (verify, reputation guard, retention) stay on fixed batches: they're database work, not waits on someone else.

Delivery events apply at about 1,200 a second from one process (`tests/load/event-throughput.test.ts`), about three times the fastest send rate, so they need nothing.

**Revisit when** a worker at its concurrency stops gaining from more, or SES raises an account's rate past what one worker sends.

## On Vardo, only the app and the worker rotate

`docker-compose.vardo-production.yml` deploys Pouch's own install on Vardo. Vardo starts `pouch` and `pouch-worker` in a new slot, waits for their healthchecks and moves traffic once they pass. `pouch-smtp`, `postgres` and `redis` are `x-vardo-shared` and stay up across deploys.

**Why shared:** `pouch-smtp` publishes 587, and a published port in a rotating service makes Vardo stop the old slot before starting the new one, which is the gap #50 was about. Postgres holds the data. Redis is the queue, and two would split it between the slots.

**`pouch-smtp` runs the image `pouch` builds, tagged `pouch:${VARDO_GIT_SHORT_SHA}`,** because Vardo won't build a shared service. The tag changes each release, so Vardo recreates `pouch-smtp` on every deploy, with a short gap on 587.

**The worker waits for its slot's `pouch` to be healthy,** which means migrated. The old release keeps running against the new schema during a deploy, so migrations follow expand and contract (`CONTRIBUTING.md`) and fail after 10 seconds waiting for a lock (`scripts/migrate.ts`) rather than queueing every query behind them.

**Not named `docker-compose.vardo.yml`:** Vardo reads that name in a slot directory as its own overlay.

**Revisit when** Vardo can recreate a shared service on each release, or SMTP moves behind a TCP router so it can rotate.

## The app lives at app.pouch.email

The marketing site takes `pouch.email`: static files in `site/`, served by the `site` service in `docker-compose.vardo-production.yml` and nowhere else, so self-hosted installs don't ship it. The app paths sent mail and existing callers point at (`/v1`, `/api/v1`, `/api/webhooks`, `/mcp`, `/u`, `/unsubscribe`, `/confirm`, `/forward`, `/download`) still route to the app on `pouch.email`, because they take POSTs and SES's subscription, and neither follows a redirect. Any other path the site doesn't have redirects to `app.pouch.email`.

**Revisit when** nothing calls those paths on `pouch.email`.
