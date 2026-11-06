# Leaving Pouch

Self-hosted, your domain sends through your own provider, not to Pouch. Leaving means changing where your code sends, not rebuilding how you send. On the hosted version the provider is the service's; see "On the hosted version".

## Your domain doesn't need Pouch. Your code currently does

Self-hosted, a domain sends through your own provider: your Amazon SES region, your credentials, your reputation. Pouch calls that provider; it doesn't replace it. The DNS records that make it work were never ours, so the domain keeps working whatever happens to us.

Your applications are the part that depends on Pouch. Anything calling `POST /v1/emails` stops sending the moment Pouch stops answering, and keeps stopping until you point it elsewhere. That's a code change you can make on your own schedule — step 2 below — but it is a code change, and it's why this page exists.

What Pouch adds on top: one API across providers, a message log the provider won't keep, a suppression list that spans every domain you send from and a dashboard. None of that is required to deliver mail.

## Self-hosted, your provider is yours

Pouch stores your provider credentials encrypted and uses them on your behalf. The provider itself, its reputation and its DNS records stay yours the entire time.

Take SES as an example. Verifying a domain publishes DKIM CNAMEs that point at `amazonses.com`, and a custom MAIL FROM record that points at `feedback-smtp.<region>.amazonses.com`. Every one of those names resolves to Amazon's infrastructure under your account, not Pouch's. Every provider Pouch supports works the same way: Pouch asks the provider for its records and tells you to publish them, never records that point at Pouch itself.

## On the hosted version

Your organization sends through the service's SES account, isolated there. The domain and its DNS are yours, but the DKIM records point at the service's provider, so leaving also means verifying the domain with a provider of your own and publishing its records. Skip step 3 below: there are no credentials of yours to revoke.

## How to leave

1. **Export your data.** From the messages screen, export the current filter as a CSV log or a full-fidelity NDJSON with nested events, bundle message bodies and attachments as `.eml` files, or pull suppressions and domain configuration. The suppressions screen exports its list as CSV, and `GET /v1/suppressions` pages through it. A body past your retention window comes back marked with why, not blank. A small export streams to the browser immediately; a larger one queues and the dashboard polls it. `POST /v1/exports` does the same thing without a browser — request one, poll `GET /v1/exports/:id`, and download the finished artifact from the signed URL it returns, so a monthly archive can run unattended. The artifact itself lives for 7 days after it's ready, then the export has to be requested again.
2. **Point your code at your provider's SDK, or another service.** Self-hosted, you already have the provider and the credentials Pouch has been using. Swap `POST /v1/emails` for your provider's own send call, or move to a different service entirely.
3. **Revoke Pouch's credentials** (self-hosted). Remove the IAM access keys (or equivalent) you gave Pouch, from your provider's console. Pouch can't send on your behalf without them.

Self-hosted, the DNS records stay as they are. They were never Pouch's to remove.

## What you lose by leaving

- **The unified log.** Your provider keeps far less history than Pouch does, and none of it spans providers.
- **The cross-domain suppression list.** A bounce or complaint on one domain no longer protects the others.
- **The dashboard.** No single view of every message across every domain and why it's in that state.
- **Message bodies past their retention window.** Pouch encrypts each body with its own key and lets that key go once your organization's retention window passes (45 days by default, configurable from 7 to 365 unless the admin set another ceiling). A body already past that point isn't recoverable here or anywhere else.

## The one real cost of staying

Your code calls `POST /v1/emails`. That's the switching cost, and it's the only one — one endpoint, one request shape. The client that wraps it, `sdk/pouch.ts`, is a single file with no dependencies, so reading it tells you everything the API does. It's on npm as `@joeyyax/pouch`, and copying the file in works too.
