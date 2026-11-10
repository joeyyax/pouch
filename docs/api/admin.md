# Admin API

`/v1/admin/*` manages every provider, organization and account. It takes an admin key and follows `docs/api/conventions.md` for errors, pagination and request ids. The generated reference at pouch.email/docs/reference, and `/openapi.json` on every install, lists every field.

## Access

- An admin key is created at Admin settings → API keys, and only there. No route creates or revokes keys.
- Any other key gets `403 admin_key_required`.
- A key whose creator is no longer an admin gets `401 invalid_key`.
- The same routes are MCP tools, listed only to admin keys (see `docs/mcp.md`).
- Every write records activity on the service, and on the organization it touched.

Credentials are write-only. No response carries them, in whole or in part. A write that stored credentials adds `credentials_verified`: `true` when the live check passed, `null` when the adapter can't check itself. A failed check returns `422 credentials_rejected` and stores nothing.

## Providers

A provider is either:

- **`shared`:** a shareable adapter (SES), belonging to the service rather than an organization. It serves every assigned organization, each isolated at the provider.
- **`single`:** an adapter that can't be shared (Mailpace, Cloudflare), created in the one organization it serves.

An organization's own row on a shared provider is an assignment, not a provider, and provider routes answer `404` for its id.

| Route | Does |
|---|---|
| `GET /v1/admin/providers` | Every provider, newest first. `?status=attention` returns the ones that aren't `ready`. |
| `POST /v1/admin/providers` | Creates a provider. Needs `organization_id` for a single-organization adapter and refuses it for SES. |
| `GET /v1/admin/providers/:id` | One provider. |
| `PATCH /v1/admin/providers/:id` | `name`, `concurrency`, `credentials`, `settings` (single only), `default_for_new_organizations` (shared only). |
| `DELETE /v1/admin/providers/:id` | Refused with `provider_in_use` while an organization is assigned, or while domains are bound to a single provider. |
| `POST /v1/admin/providers/:id/test` | Runs the live check and records it as the provider's latest probe. |
| `POST /v1/admin/providers/:id/setup` | Runs setup again. Every step is idempotent. |
| `GET /v1/admin/providers/:id/convert` | The conversion plan and the latest run. No provider call. |
| `POST /v1/admin/providers/:id/convert` | Starts moving a legacy SES provider onto a shared one. |
| `POST /v1/admin/domains` | Adopts a domain the provider already holds, for one organization. |

`issues` lists what needs attention, most urgent first:

- `needs_conversion`: an SES provider from before shared sending.
- `credentials_failing`: the last check failed.
- `backing_off`: the provider asked for backoff.
- `setting_up`: setup hasn't finished.
- `quota`: 80% of the daily sending quota is used.

`status` is the first of those, or `ready`. While a conversion runs, it reads `converting` instead of `needs_conversion`. The admin screen shows the same list as chips.

Changing credentials or `concurrency` on a `shared` provider changes every organization's copy in the same write. Its `settings` are written by setup and can't be patched.

## Setup and conversion

**Setup runs inline.** It's about ten paced provider calls at SES's one-a-second limit, the same work adding a first domain does. The response says whether it finished in `configured`. A step that fails is retried by calling it again.

**Conversion runs in the background.** Copying the suppression list costs one paced call per address, so a large list takes longer than any request should stay open.

1. `POST .../convert` checks the provider can be converted, then answers `202` with `started: true` and the plan. A check that fails answers `422` and starts nothing.
2. Poll `GET .../convert` until `conversion.state` is `done` or `failed`. It keeps answering after the move, since the id doesn't change.
3. A failed run reports `stopped_at`, `reached`, `error` and, for missing IAM permissions, `missing_permissions`. `POST` again resumes at the stage that failed.

A second `POST` while a run is live answers `started: false`. A run records a heartbeat every 30 seconds. One silent for two minutes reads `interrupted: true`, and the next `POST` takes it over. The run lives in the web process, so a deploy interrupts it.

The command line does the same work: `scripts/convert-provider.ts` (see `docs/engineering.md`).

## Adopting a domain

`POST /v1/admin/domains` takes over a domain the provider already holds and Pouch didn't create — a self-managed SES setup moving onto Pouch. It takes `organization_id`, `name` and an optional `provider_id`, defaulting to the organization's assigned provider.

It tags the domain as that organization's, attaches it and keeps its existing DKIM, so the domain never stops sending. It doesn't create the domain, doesn't rotate signing keys and sets the MAIL FROM domain only when the domain has none. The credentials that find the domain are the assigned provider's own, which is what proves the domain is in that AWS account.

- **Admin-only.** `POST /v1/domains` answers `domain_unavailable` for the same name, with no adopt path, and so do the organization screens.
- **Untagged means unclaimed.** A domain tagged for another organization or provider stays `domain_unavailable`.
- **Nothing there to adopt** is `domain_not_at_provider`. Add the domain instead.
- The response is the domain, verified straight away when the provider already sends for it, plus `adopted: true`.

## Assignments

| Route | Does |
|---|---|
| `GET /v1/admin/providers/:id/organizations` | The organizations the provider serves, with each assignment's id, domain count and status. |
| `POST /v1/admin/providers/:id/organizations` | Assigns `organization_id`. |
| `DELETE /v1/admin/providers/:id/organizations/:organizationId` | Unassigns. Refused while domains are bound. |

- **Provider calls:** assigning makes none. The organization's space at the provider is created when it adds its first domain. Unassigning removes it first.
- **Repeats:** assigning an organization already on the provider returns the same assignment.
- **Default:** the assignment becomes the organization's default when it has none. `default: true` makes it the default regardless.
- **Refusals:** an organization gets one assignment, so a second one answers `422`. A single provider can't be assigned to another organization.

## Organizations

| Route | Does |
|---|---|
| `GET /v1/admin/organizations` | Every organization, newest first, with its default provider, assignment count, domain count and suspension. |
| `GET /v1/admin/organizations/:id` | One organization. |
| `PATCH /v1/admin/organizations/:id` | Any of `provider_id`: the default, which must be one of the organization's assignments; `address_limit`: active addresses; `address_daily_message_limit`: messages per address per UTC day. Either takes `null` to go back to the install's default (`address_limit_default`, 500, and `address_daily_message_limit_default`, 100). The response carries the limit in force and, as `address_limit_override` and `address_daily_message_limit_override`, the organization's own or null. Each change is in the organization's activity and the service's. |
| `DELETE /v1/admin/organizations/:id` | Deletes the organization, its domains at the provider, its keys, people and send history. Refused while it has mail waiting to send or holds the system from address's domain. |
| `POST /v1/admin/organizations/:id/suspend` | A manual suspension with `reason`. Queued mail fails. |
| `POST /v1/admin/organizations` | Creates an organization. The key's creator owns it, and it's assigned the default provider when one is set. |
| `POST /v1/admin/organizations/:id/release` | Releases a suspension of any source. |

`provider_id` is the row domains bind to, and `managed_provider_id` is the provider an admin manages it on. Suspend and release answer `changed: false` when the organization was already in that state.

## Members

Who is in an organization and what they may do there. The roles are `owner` and `member` — see `docs/decisions.md`, "Admin is service-wide; an organization has owners and members".

| Route | Does |
|---|---|
| `GET /v1/admin/organizations/:id/members` | The organization's members, oldest first. |
| `PATCH /v1/admin/organizations/:id/members/:userId` | `role`. Demoting the last owner is refused. |
| `DELETE /v1/admin/organizations/:id/members/:userId` | Removes the membership. Removing the last owner is refused. |

**Removing someone doesn't revoke the keys they created.** An organization key carries the organization's authority, not a person's, so a removal leaves live sending alone. Rotate the organization's keys when the person isn't trusted.

Adding someone is an invitation, below. The dashboard's equivalent of both is Settings → Members, owner-only, and there's no organization-key route for any of this: a key records who minted it, not who is using it, so it can't grant a person standing access.

## Invitations

An invitation mails a one-time link that expires in 7 days. Redeeming it creates the account when the address has none, and adds the membership either way — public sign-up is off, so this is how anyone but the seeded admin gets in.

| Route | Does |
|---|---|
| `POST /v1/admin/organizations/:id/invitations` | `email`, `role`. Mails the link and returns the invitation. |
| `GET /v1/admin/organizations/:id/invitations` | The organization's invitations, newest first. `?status=` narrows to `pending`, `accepted`, `revoked` or `expired`. |
| `DELETE /v1/admin/organizations/:id/invitations/:invitationId` | Revokes a pending one. The link stops working immediately. |
| `POST /v1/admin/organizations/:id/invitations/:invitationId/resend` | Mails a new token, resets the 7-day window and kills the old link. |

- The token is mailed and never returned. No route reads it back.
- One live invitation per address per organization: a second is `422 validation_failed`. Resend or revoke the first.
- An address already in the organization is refused. An address that already has an account joins it rather than getting a second one, by signing in and opening the link.
- `status` is `pending`, `accepted` or `revoked` as stored; `expired` is a pending invitation past `expires_at`.
- Without the system from address configured, a send is `503 provider_unavailable` and nothing is created.
- Invites are rate-limited per organization and per invited address. Over either, `429 rate_limit_exceeded` with `Retry-After`.
- `role` is `owner` or `member`. The service-wide admin flag is granted afterwards, on `PATCH /v1/admin/users/:id`.

## Accounts

The service-wide admin flag and account deletion. Both are also on Admin settings → Admins.

| Route | Does |
|---|---|
| `GET /v1/admin/users` | Every account, newest first, with its memberships. `?admin=true` narrows to service admins, `?email=` looks one up. |
| `GET /v1/admin/users/:id` | One account. |
| `PATCH /v1/admin/users/:id` | `admin`: the service-wide flag. |
| `DELETE /v1/admin/users/:id` | Deletes the account. |

- Revoking the flag revokes the admin keys that account created (`docs/decisions.md`, "Admin keys die with their creator's admin role"). Revoking your own key's creator stops that key with it.
- Deleting an account takes its memberships and sessions with it and revokes the admin keys it created. Organization keys it minted keep sending.
- The last admin can't be demoted or deleted: `422 validation_failed`. A service with no admin has no way back in short of `pnpm reset:admin` on the host.
- Creating an admin key is still dashboard-only, so a leaked admin key can't mint more.

## Idempotency

The admin routes don't take `Idempotency-Key`. A repeated write is safe without it:

- A repeated create is refused with `provider_exists`.
- Assigning, suspending and releasing leave an existing state as it is.
- A repeated `POST .../convert` joins the run in progress.
- A repeated organization create is refused with `validation_failed` on `slug`.
- Setting the admin flag, changing a role and removing a member all leave an existing state as it is.
