# Security

## Reporting a vulnerability

Report privately, not as a public issue. Two ways:

- GitHub's private vulnerability reporting, from the Security tab of this repository. Preferred — it keeps the report, the fix and the advisory in one place.
- Email joey@joeyyax.com with `security` in the subject.

Include what you did, what happened, and what you expected. A proof of concept helps; a working exploit isn't required and isn't wanted in a public place.

Expect an acknowledgement within three working days and an assessment within seven. You'll be credited in the advisory unless you'd rather not be.

## Supported versions

Pouch has no released versions yet. Fixes go to `main`, which is what every deployment tracks.

## What's in scope

The app, the worker, the SMTP ingress and the deployment files in this repository. A hosted instance at pouch.email is also in scope; say so in the report if that's where you found it.

Out of scope: findings against a provider's own service (SES, Mailpace, Cloudflare), missing hardening headers with no demonstrated impact, and reports produced by a scanner with no analysis attached.

## What Pouch holds

Worth knowing when you're looking: provider credentials are encrypted at rest with `ENCRYPTION_KEY`, message bodies live in object storage under an opaque key and are encrypted with a per-message key held on the message row, and API keys are stored as hashes. Error reports are scrubbed against an allowlist before leaving the process (`lib/errors/scrub.ts`). Anything that defeats one of those is the kind of report this file is for.
