# Migrating to Pouch

One guide per provider, for moving an app's outbound mail to Pouch. Each covers the send call before and after, field mapping, domains and DNS, webhooks, moving suppressions and a cutover checklist.

Pouch sends through two provider adapters today: Amazon SES and Mailpace. Admins own providers and assign each organization one. Moving from a provider Pouch doesn't speak to directly (Resend, SendGrid, Postmark, Mailgun, useSend) means adding your domain on that provider and publishing its records (`docs/product/brief.md`, "Providers and providers"). Self-hosted, moving from SES or Mailpace can keep the same backing provider.

## On the hosted version

Your organization sends through the service's SES account, isolated there, with its own reputation and suppression list. Add the domain, publish the DNS records it lists and it's ready once they verify. Settings → Sending shows the provider, and `GET /v1/providers` returns it with `assigned: true`.

## Guides

- [Resend](./resend.md)
- [Amazon SES](./ses.md)
- [useSend](./usesend.md)
- [SendGrid](./sendgrid.md)
- [Postmark](./postmark.md)
- [Mailgun](./mailgun.md)
- [Mailpace](./mailpace.md)

## What every guide assumes

- You have a Pouch API key (`sk_live_…` or `sk_test_…`) and, for adding domains or reading providers, one scoped to no domain (`docs/api/conventions.md`).
- Your organization has an assigned provider. Self-hosting, you're the admin: add an SES or Mailpace account and assign it (`docs/engineering.md`, "Providers").
- The SDK referenced throughout is `@joeyyax/pouch` on npm, built from `sdk/pouch.ts`: one file, no dependencies. Every SDK example has an equivalent plain REST call. It covers every key-authenticated route except the two event streams.

## What doesn't move

Across every provider, three things don't carry over, by design (`docs/product/brief.md`, "What Pouch is not"):

- **Templates.** Pouch sends the HTML and text you give it. A domain can carry a logo, accent color and footer (`layout`), but there's no template store, no blocks and no variables beyond bulk mode's flat attribute substitution.
- **Open and click tracking.** No pixels, no rewritten links, no open or click events. Delivery, bounce and complaint state come from the receiving server, not from watching the recipient.
- **Scheduled sends.** `POST /v1/emails` sends immediately. Queue scheduled mail on your side and call Pouch when it's time to send.
