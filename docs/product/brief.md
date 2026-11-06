# Pouch — product brief

## Purpose

Pouch sends transactional email for a developer's projects and client sites through one API, with the delivery provider a detail of the domain rather than of the caller.

It's built to reduce the number of things a developer has to think about when an app needs to send mail: one key, one endpoint, one place to look when a message doesn't arrive.

## What Pouch is

A **transactional email service** with a provider-agnostic core, and a bulk mode on the same core.

- A send API shaped like Resend's, trimmed to what a transactional caller uses
- A message log the service owns, with a lifecycle from queued to delivered or failed
- A suppression list that applies across every domain
- Domain verification that asks the provider for its DNS records and polls until they resolve
- A dashboard that shows every message, its state, and why it's in that state
- Providers as adapters behind one interface: Mailpace, Amazon SES, Cloudflare Email Service, with room for more
- Doors into the API beyond HTTP: an SMTP ingress for software that only speaks SMTP
- Inbound per domain, delivered to a webhook and held briefly, and programmable addresses on it that code creates with an expiry, reads, replies from and forwards to mailboxes that confirmed
- Bulk: batches to a list or an inline recipient array, with unsubscribe handled per domain

## What Pouch is not

- A mail server. It runs no MTA, owns no IPs and manages no reputation. Providers do that.
- A marketing platform. No segments, no contact profiles, no campaign builder, no automation. Bulk mode sends to a list and honors unsubscribes.
- A template system. Callers own the body. A domain can own a frame: logo, accent color, footer.
- A tracking product. Delivery and bounce rates per domain are in. Opens, clicks, pixels and rewritten links are out.
- A mail client. Inbound is a pass-through to a webhook with a short buffer. No folders, no IMAP, no replying from the dashboard.
- A billing system. Usage is visible; invoicing happens elsewhere.
- An orchestrator. It reports what's running and how healthy it is; starting, stopping and scaling belong to whatever runs the containers.
- An SMS or push service. A notification layer above Pouch picks channels; Pouch is the email leg.

## Core principles

### Restraint is the feature
Every addition has to answer why a transactional caller needs it. Resend drifted into audiences and broadcasts; Mailpace stayed small. Pouch keeps Mailpace's scope and adds the dashboard Mailpace lacks.

### The provider is the domain's business
A domain is bound to one provider. Callers see domains and messages, never providers. Switching a domain's provider is a settings change, not a code change in the caller.

### The service owns the truth
Every send is a row in Pouch's own database. Provider events update it. Provider retention limits and provider dashboards don't matter, because the record lives here.

### The record is yours
The service owns the truth; the business owns the record. Every message, event and suppression comes out on demand, in formats that outlive us — CSV for the log, `.eml` for the mail itself, which any client can open. Export is a button, not a support request. Message bodies are the one limit, and it's the encryption doing it: past an organization's retention window the key is gone, so an export says which bodies it couldn't give you and why rather than handing back a blank.

### A dependency, but a replaceable one

Pouch sits between a caller and a provider, and it should be honest about what that means. While an app sends through Pouch, Pouch is in the path: if it's down, that app's mail waits. Calling it "not load-bearing" would be a lie, and it's the reason alerts about the service itself go over push rather than through Pouch's own send path.

What Pouch never becomes is a trap. Self-hosted, the provider is the admin's own: their SES, their credentials, their DNS, their sending reputation. Turn Pouch off and the domain still exists at the provider and still delivers; what stops is every app pointed at `POST /v1/emails`, until it's pointed somewhere else.

On the hosted version the provider is the service's, and the customer's domain sends through it, isolated from every other customer. The domain and its DNS stay the customer's, so leaving means verifying the domain with a provider of their own.

Past that, leaving is a code change rather than a migration: the client is one file, the API is small enough to swap for a provider's own SDK, and the record comes out in formats that outlive us. Leaving is a documented path (`docs/leaving.md`), not a question we hope nobody asks.

### Delivery, not surveillance
A message shows as queued, sent, delivered, deferred, bounced, complained or failed. Delivery state comes from the receiving server. Reads and clicks come from watching the recipient, and Pouch doesn't watch recipients. Rates per domain are computed from delivery events and nothing else.

### Fail loudly and early
A send to a suppressed address fails at the API, with the reason. A domain that isn't verified can't send. A provider rejection is recorded with its message, never swallowed.

### Built for one, shaped for many
Every row carries an organization id. Any signed-in user can create an organization unless an admin limits it to admins and organization owners, or to admins alone. Public signups stay off until per-organization caps on domains and send volume exist (#292).

## Core concepts

The nouns and their relationships are `model.md`. This is what each one is for.

### Organizations
Every record belongs to an organization. A user can belong to several, with a role in each, and each organization is assigned one provider. Signing up creates the person and their own organization together. The full shape is `model.md`.

### Accounts and roles
An account is a person — a `users` row. Inside an organization a person is an `owner` or a `member`: members do the sending work, owners own the shape of the organization, its people and settings. Admin is a separate, service-wide flag reaching Pouch's own admin surface. Neither axis reads the other.

### Domains
A domain is a verified domain mail sends from, bound to one provider. It carries its DNS records, its verification status and, once inbound lands, whether it accepts mail.

### API keys
A key belongs to an organization and is scoped to one or more domains. It's shown once and stored hashed. Each key has a rate limit and a last-used timestamp. Test-mode keys route to a mock provider that records the message and emits synthetic events.

### Messages
A message is one outbound email with one lifecycle:

`queued → sent → delivered | deferred | bounced | complained | failed`

`deferred` can return to `sent` when the provider retries. A `delivered` message can still become `complained` — someone has to receive a message to report it — or `bounced`, when the receiving server accepts and gives up later. Its `delivered_at` stays either way. Every transition is a row in `message_events` with the provider's reason.

### Layouts
A domain can carry a frame: logo, accent color, footer text. A send with `layout: true` wraps the caller's HTML in it. Off by default. No variables, no per-message templates.

### Recipients
Every address a domain has sent to, derived from messages: domains it received from, last state, whether it's suppressed or unsubscribed, every message to it. A directory, not a list.

### Lists
Bulk mode. A list is a named set of addresses per domain with subscription state and a flat attribute map. A batch sends to a list or an inline recipient array. A domain's provider decides whether bulk is allowed on it.

Lists grow by explicit act, never by side effect. Every membership carries a source: `api` when a caller passes `subscribe` on a send, with the message id as evidence; `import` for CSV and API imports; `manual` when added from the recipients view, with who and when. A transactional send on its own never adds anyone to a list.

Lists double opt-in by default. A new membership is `pending` until the address opens a signed confirmation sent from the domain, in its layout. Pending addresses never receive a batch. Imports can be marked confirmed by the importer, and the membership records that. A list can turn double opt-in off, and each membership records which mode applied.

### Unsubscribes
One step, no confirmation. Every bulk message carries a per-recipient signed link and one-click headers. Opening the link or pressing the mail client's unsubscribe button removes the address from the list and shows a page saying so. The API has the same door for apps with their own preferences page, and a domain can point the footer link at its own page, which redeems the token in the background. An unsubscribe applies to the list, with a one-link option for all mail from the domain, and is separate from suppression.

### Inbound
A domain opts in by registering a webhook. Mail to any address on its inbound subdomain is normalized, delivered to the webhook with retries, and held for a retention window, seven days by default and thirty at most, for redelivery and debugging. Attachments and the original message are downloadable for the same window. In-reply-to is matched to an outbound message id when one exists.

### Suppressions
An address that hard-bounced or complained on any domain. Sends to it fail at the API until the address is removed by hand.

### Recipient history
A per-address, per-organization rollup: last delivered, last bounced, bounce count, last complained, last deferred, first seen. `POST /v1/emails` warns, in `warnings`, when a recipient's history is worth flagging — it never changes whether the message is accepted. Kept indefinitely, the same deliberate exception to retention as suppressions: both are safety lists, not history, and both exist so we don't repeat a known failure.

### Providers and adapters
A provider is one set of credentials for an email service: a Mailpace organization, an SES region. An adapter is the code that talks to that service — one per service, all implementing `Adapter`: send, domain records and verification, event parsing. Retry, failover and telemetry are adapters that wrap an adapter. Admins own every provider, and credentials are stored encrypted and never shown again.

Each organization is assigned one provider, the one named as the default for new organizations unless an admin picks another. On a shareable provider (SES), the organization gets its own isolated space on it, created with its first domain. An organization reads its provider and never changes it. A domain binds to the assigned provider, and its adapter does the work.

### System mail
Pouch sends confirmations, layout previews, password resets and digests from one address, set in admin settings. Its domain is one verified in some organization, and that organization's provider carries the send. It's system mail: no organization's log holds it, and admins read it in admin settings. Unset, it's `support@` on the oldest verified domain, so a fresh install configures nothing. Admin alerts about the service itself go over push, not email, so an outage can report itself.

## What done looks like

The developer deletes the Resend provider. Every project and client site sends through one API key. The dashboard shows every message across every domain with its current state and why.
