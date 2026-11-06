# Voice

One voice, two readers. A developer reads API errors and docs in a terminal. An owner or admin reads the dashboard. Both get the same register: direct, specific, calm.

## Rules

- **State what happened. Stop.** "Domain not verified." Not "Oops, it looks like this domain hasn't been verified yet!"
- **Name the thing.** The address, the domain, the key, the provider's reason. Never "something went wrong".
- **Say what to do next when there is a next.** "Add the DKIM record and verify again." Skip it when the sentence already says it.
- **No exclamation marks. No emoji. No "please".**
- **Sentence case** everywhere: headings, labels, buttons, error messages.
- **Present tense.** "Sends to this address fail." Not "will fail".
- **Numbers are exact and scoped.** "3 of 4 records found." Not "some records missing".
- **US English, contractions, no Oxford comma.**

## API errors

Every error is a JSON body with `code`, `message` and, where useful, `field` or `detail`. The `message` reads as one sentence a developer can act on without opening the docs.

| Situation | Message |
|---|---|
| Suppressed recipient | `Recipient is suppressed: hard bounce on 2026-08-14.` |
| Unverified domain | `Domain example.com isn't verified. Add the listed DNS records and verify.` |
| Domain not added | `Domain example.com hasn't been added. Add it with POST /v1/domains.` |
| Key not scoped to domain | `This key can't send from example.com.` |
| Missing field | `Field "to" is required.` |
| Provider rejection | `Provider rejected the message: <provider's reason, verbatim>.` |
| Rate limit | `Rate limit exceeded for this key. Retry after 12 seconds.` |
| Fan-out held | `This exact message has reached 240 recipients today, which mailbox providers treat as bulk. Add a List-Unsubscribe header to keep sending it.` |

Provider reasons are quoted, not paraphrased. The developer needs the exact string to search for.

## Dashboard

- **Empty states say what will appear and how to make it appear.** "No messages yet. Send one with your API key and it shows up here."
- **Status labels are the lifecycle words.** Queued, sent, delivered, deferred, bounced, complained, failed. No synonyms, no "in transit".
- **Toasts confirm, they don't celebrate.** "Key revoked." "Domain added."
- **Destructive actions name the consequence.** "Revoke this key? Anything using it stops sending immediately."
- **Time is relative under a day and absolute after.** "4 minutes ago" then `2026-09-07 14:32`.

## Docs

- Condition before instruction. "To send from a new domain, add it and verify it."
- Code font for anything typed or returned.
- One name per thing. It's "key", never "token" or "credential". It's "domain", never "sender" or "identity".
- Examples use `example.com` and `example.net` and made-up people.

## Where the product name appears

The product name comes from the `brand` constant and appears in the dashboard title, the from-name on system mail and the docs header. It appears nowhere in code identifiers, environment variables, table names or routes.

The token that goes out on the wire — export headers, export filenames — is a separate frozen constant in `lib/wire.ts`, not this one. It spells the same thing today and doesn't change if the product is renamed.
