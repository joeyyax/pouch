# The model

What the nouns are and who owns what. `docs/decisions.md` says why each one is shaped the way it is; this page says what the shape is.

## In one paragraph

A **user** is a person. Users belong to **organizations**, with a role in each. An organization holds **domains**, and is assigned one **provider** — a set of credentials for an email service, driven by an **adapter**. Mail sent through a domain is a **message**, and everything the provider says about it afterwards is a **message event**. A few rows belong to the service itself rather than to any organization, and those carry a null `organization_id`.

## Who someone is

**User.** One person, one row in `users`. Signing up creates the user and their own organization in the same step, so nobody lands without somewhere to work.

**Membership.** A user belongs to an organization through `memberships`, which carries the role: `owner` or `member`. A user can belong to several organizations, with a different role in each.

**Invitation.** An offer of a membership, sent to an address as a one-time link that expires in 7 days. Redeeming it creates the account when the address has none, and adds the membership either way. With public sign-up off, it's the only way a `users` row is created after the seed.

**Admin** is separate: `users.admin`, a service-wide flag with no membership behind it. It grants Pouch's own admin surface — providers, other organizations, system settings. The two axes never read each other. The same person is an admin, a member of one organization and an owner of another.

Who can do what inside an organization is the table in `docs/decisions.md`, "Admin is service-wide; an organization has owners and members". The short version: members do the sending work, owners own the shape of the organization — its people, its settings, whether it exists.

## What an organization holds

**Organization.** The unit of ownership. Every record belongs to one, and a query without an `organization_id` is a bug.

**Domain.** A verified domain mail sends from, bound to one provider, carrying its DNS records and verification state. A domain name can repeat across organizations — uniqueness is per organization, not global.

**API key.** Belongs to an organization, optionally scoped to domains, shown once and stored hashed. A key carries the organization's authority and no person's: it records who minted it, not who is using it, which is why no role is enforced on the API.

**Message.** One outbound email and its lifecycle, with every transition recorded as a `message_events` row carrying the provider's own reason. Lists, batches, recipients, suppressions and layouts all hang off the same organization.

## What sends the mail

**Provider.** One set of credentials for an email service: an SES region, a Mailpace organization. A `providers` row. Admins own every provider; an organization reads the one it's assigned and never changes it.

**Adapter.** The code that talks to one email service — `lib/providers/adapters/`, all implementing `Adapter`. The provider row says which adapter drives it. Nothing outside an adapter touches a provider SDK, so what Pouch can do is the interface, not any one service's feature list.

A provider is either **shared** or **single**:

- **Shared** providers belong to the service (null `organization_id`) and carry several organizations. On a service that supports it, each organization gets its own isolated space on the provider, created with its first domain. SES calls that space a tenant; the word stays inside the adapter and never reaches the product.
- **Single** providers belong to one organization and serve it alone.

A new organization is onboarded onto the shared provider named by `service_settings.default_provider_id`.

## What belongs to the service

Some rows are the install's, not anyone's. They carry a null `organization_id`, and check constraints hold the rule in both directions:

- **Shared providers** — `shared` is true exactly when the organization is null.
- **Admin-scope API keys** — `scope = 'admin'` exactly when the organization is null. An admin key is refused on ordinary `/v1` routes and works only under `/v1/admin/*`.
- **Service-level activity** — a write that belongs to no organization records against none.
- **`service_settings`** — one row, holding the system from address, the addresses system alerts go to and the default provider.

There's no system organization. There was, briefly, because two columns were `NOT NULL`; a column that says "no organization" is the honest version.

**System mail** — password resets, confirmations, admin alerts — sends from the address in `service_settings.system_from_address`. That address resolves everything else: its domain has to be verified in some organization, and that organization's provider sends it, with the message landing in that organization's log. Unset, it's `support@` on the oldest verified domain.

## Where it lives

| Noun | Table | Owner |
|---|---|---|
| User | `users` | themselves |
| Membership | `memberships` | an organization |
| Invitation | `invitations` | an organization |
| Organization | `organizations` | — |
| Domain | `domains` | an organization |
| API key | `api_keys` | an organization, or the service |
| Message, event | `messages`, `message_events` | an organization |
| List, batch, recipient | `lists`, `list_memberships`, `batches`, `recipient_history` | an organization |
| Address, forward target | `addresses`, `address_forward_targets` | an organization |
| Provider | `providers` | an organization, or the service |
| Adapter | `lib/providers/adapters/` | code, not data |
| Service settings | `service_settings` | the service |

## Words we don't use

**Tenant** is SES's word for an isolated space on a shared account. It's real, it's in the adapter and it appears nowhere a user can see. The product word is the organization's space on the provider.

**Provider** never means the code. The code is an adapter. A provider is the email service and the credentials for it.

**Account** is a person's account, and a person is a `users` row. It never means a set of provider credentials — that's a provider. The `accounts` table is Better Auth's own, holding sign-in credentials for a user, and nothing in the product surface calls it that.
