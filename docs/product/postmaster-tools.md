# Gmail Postmaster Tools

Google's own dashboard for how Gmail sees a sending domain: spam rate, delivery errors, authentication and encryption rates. Pouch doesn't integrate with its API (see #297) — this is about using the two together.

## What it shows

Spam rate, IP and domain delivery errors, feedback loop identifiers, authentication (SPF/DKIM/DMARC) success, and TLS encryption rate, each by day. It's Gmail's own read on your mail, not Pouch's.

## Verifying a domain

Add Postmaster Tools at [postmastertools.google.com](https://postmastertools.google.com), then verify ownership with a DNS record — a TXT or CNAME, whichever Google gives you at setup. Pouch's DNS records screen lists it as a recommended record alongside DMARC; it's optional and never blocks verification or sending. See [Google's setup guide](https://support.google.com/mail/answer/9981691) for the exact steps.

Verifying the parent domain also covers its subdomains, so verify the domain that authenticates your mail — for SES, that's the DKIM `d=` domain.

## No data yet

Low-volume domains show no data in Postmaster Tools. This isn't an error — Google only reports once a domain crosses its own volume threshold. If a domain's dashboard is empty, send more mail through it and check back.

## Pouch's Feedback-ID header

Every message Pouch sends through a provider that carries custom headers gets a `Feedback-ID` header, unless the caller already set one. Format, per [Google's guidelines](https://support.google.com/mail/answer/6254652):

```
Feedback-ID: <organization id>:<mail type>:pouch
```

- **Organization id** — the sending organization, so Postmaster Tools can split spam rate by organization on a shared domain.
- **Mail type** — `transactional` or `bulk`.
- **`pouch`** — the sender id, stable across every message.

A provider that drops custom headers in transit (Mailpace, for instance) never gets this header — Google's data would be meaningless for a header the recipient's server never receives.
