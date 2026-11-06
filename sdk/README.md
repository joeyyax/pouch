# Pouch SDK

A single-file TypeScript client for Pouch's API: send email and batches, read messages and inbound mail back, and manage domains, lists, suppressions, exports, keys and webhook endpoints. Zero dependencies, `fetch` only. Works on Node 20+ and in any modern runtime.

It covers every key-authenticated route except the two event streams. `/v1/admin` isn't here — an admin key manages the whole install and belongs in an operator's tooling, not in customer code. `tests/unit/sdk-coverage.test.ts` fails when a route has neither a method here nor an entry in its exceptions list, so a new route can't land without that decision being made.

## Install

```sh
npm install @joeyyax/pouch
```

ESM and CommonJS, with types. Copying `pouch.ts` into a project still works too.

The package is versioned on its own, from 0.1.0; 0.2.0 makes `baseUrl` required. A version covers the `/v1` routes that exist when it's published; a new route ships in a minor release.

MIT licensed — see `LICENSE` in this directory. The server it talks to is AGPL-3.0; this client
deliberately isn't, so importing it carries no obligation.

## Use

```ts
import { PouchClient, PouchError } from "@joeyyax/pouch";

const pouch = new PouchClient({
  apiKey: process.env.POUCH_API_KEY!, // sk_live_... or sk_test_...
  baseUrl: process.env.POUCH_URL!, // your install: https://mail.example.com, or http://localhost:3100 in dev
});

try {
  const message = await pouch.emails.send(
    {
      from: "Pouch <hi@example.com>",
      to: "ada@example.com",
      subject: "Welcome",
      html: "<p>Thanks for signing up.</p>",
    },
    { idempotencyKey: crypto.randomUUID() }, // safe to retry with the same key
  );

  console.log(message.id, message.status, message.url);

  const sent = await pouch.emails.get(message.id);
  console.log(sent.events);
} catch (error) {
  if (error instanceof PouchError) {
    // error.code is stable and safe to branch on: "domain_not_verified", "rate_limit_exceeded", ...
    console.error(error.code, error.message, error.field, error.detail);
    if (error.code === "rate_limit_exceeded") {
      console.error(`retry after ${error.retryAfter}s`);
    }
  } else {
    throw error;
  }
}
```

Read the log back with `emails.list`, filtered the same way `GET /v1/emails` is:

```ts
const page = await pouch.emails.list({ status: "bounced", domain: "dom_1", since: "2026-01-01T00:00:00Z" });
for (const message of page.data) console.log(message.id, message.to, message.reason);
```

`emails.get` is the only call that fills in `events` and `stall`. Watching a message as it moves is the `GET /v1/emails/:id/events` stream, which the SDK doesn't wrap — point an `EventSource` at it, or read the response body yourself.

## Domains

An admin assigns each organization a provider, and a new domain binds to it. With none assigned, `create` throws `provider_unassigned`.

```ts
const domain = await pouch.domains.create({ name: "example.com" }); // binds to the organization's assigned provider

console.log(domain.dns_records); // publish these, then verify

const verified = await pouch.domains.verify(domain.id);
console.log(verified.status, verified.missing_records);

const page = await pouch.domains.list({ limit: 20 });
for (const d of page.data) console.log(d.name, d.status);
if (page.next_cursor) {
  await pouch.domains.list({ cursor: page.next_cursor });
}

await pouch.domains.update(domain.id, { bulk_allowed: true }); // batches need this on
await pouch.domains.delete(domain.id); // only once nothing has sent from it
```

## Providers

Read-only. Admins create, rotate and assign providers; an organization reads the one its domains bind to.

```ts
const { data } = await pouch.providers.list();
const assigned = data.find((provider) => provider.assigned);
console.log(assigned?.adapter, assigned?.status);
```

## Inbound

Turn inbound on per domain, then read what arrives.

```ts
const settings = await pouch.domains.updateInbound("dom_1", {
  enabled: true,
  webhook_url: "https://example.com/hooks/inbound", // a fresh URL rotates the signing secret
  retention_days: 14,
  subdomain: "intake", // mail to anything@intake.<domain>
});
console.log(settings.webhook_secret); // returned once, the moment it's registered
console.log(settings.dns_records); // publish the inbound record too

const page = await pouch.inbound.list({ domain: "dom_1" });
const mail = await pouch.inbound.get(page.data[0].id);
const pdf = await fetch(mail.attachments[0].download_url!); // links last 15 minutes from the read
const original = mail.raw_download_url && (await fetch(mail.raw_download_url)); // message/rfc822
```

## Lists and batches

A batch draws recipients from a list or takes them inline, and the sending domain needs `bulk_allowed`.

```ts
const list = await pouch.lists.create({ domain_id: "dom_1", name: "product-news" });

await pouch.lists.members.add(list.id, { address: "ada@example.com", attributes: { name: "Ada" } });

const imported = await pouch.lists.members.import(list.id, {
  members: [{ address: "grace@example.com" }, { address: "alan@example.com" }],
  confirmed: true, // skips double opt-in, for a list you already confirmed elsewhere
}); // at most 5000 rows per call
console.log(imported.added, imported.already_present, imported.errors);

const batch = await pouch.batches.send({
  from: "Pouch <hi@example.com>",
  subject: "{{name}}, what's new",
  html: "<p>Hi {{name}}.</p>",
  list: list.id,
});
console.log(batch.recipient_count, batch.skipped_count);
console.log((await pouch.batches.get(batch.id)).counts); // live, reread for a current picture

await pouch.lists.unsubscribe(list.id, { address: "ada@example.com" });
await pouch.domains.unsubscribe("dom_1", { address: "ada@example.com" }); // every list on the domain

const csv = await pouch.lists.exportCsv(list.id); // the same shape members.import takes
```

Redeeming a confirmation or unsubscribe token isn't here: `POST /v1/confirm` and `POST /v1/unsubscribe` take a token rather than a key, and the hosted pages are what call them.

## Exports

Always asynchronous. Request one, then poll.

```ts
const requested = await pouch.exports.create({ kind: "log_csv", since: "2026-01-01T00:00:00Z" });

let current = await pouch.exports.get(requested.id);
while (current.status === "requested" || current.status === "running") {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  current = await pouch.exports.get(requested.id);
}

if (current.status === "ready") console.log(current.download_url); // minted fresh on every read
```

## Keys and webhook endpoints

An endpoint belongs to a key: only a send made with that key produces events for it.

```ts
const key = await pouch.keys.create({ name: "worker", domain_ids: ["dom_1"] });
console.log(key.secret); // returned by this call only

const endpoint = await pouch.webhookEndpoints.create({
  key_id: key.id,
  url: "https://example.com/hooks/pouch",
  events: ["email.delivered", "email.bounced"],
});
console.log(endpoint.secret); // verify signatures with this

await pouch.webhookEndpoints.update(endpoint.id, { disabled: true }); // stops delivery, keeps the endpoint
const rotated = await pouch.webhookEndpoints.rotateSecret(endpoint.id); // old secret stops verifying at once
console.log(rotated.secret);

await pouch.keys.delete(key.id); // revokes it; the row stays so its messages keep naming it
```

## Organization

```ts
const organization = await pouch.organization.get();
await pouch.organization.update({ body_retention_days: 90 });
```

## Reputation

```ts
const reputation = await pouch.reputation.get(); // needs a key with no domain scope
if (reputation.standing !== "healthy") console.log(reputation.reason);
```

## Stats

```ts
const week = await pouch.stats.get({ window: "7d", include: ["latency", "domains"] });
console.log(week.counts.bounced, week.previous_counts.bounced, week.latency?.end_to_end.p95_ms);
```

## Suppressions

Every call here needs a key with no domain scope.

```ts
const result = await pouch.suppressions.import({
  source: "postmark",
  reason: "hard_bounce", // for rows that don't set their own
  suppressions: [
    { address: "ada@example.com" },
    { address: "grace@example.com", reason: "complaint" },
  ],
}); // at most 5000 rows per call

console.log(result.added, result.already_present, result.invalid, result.errors);

const page = await pouch.suppressions.list({ reason: "complaint", limit: 100 });

await pouch.suppressions.remove("ada@example.com");
```

An address that's already suppressed keeps its existing row and counts as `already_present`. An invalid row lands in `errors` and the rest still import. Removing an address that isn't on the list is a `404`.

## Test mode

Pass a `sk_test_...` key and every call behaves the same, except nothing sends: messages route to a mock provider and resolve to `delivered` or `bounced` a few seconds later. Nothing in the SDK changes; the key decides.

## Idempotency

Pass `idempotencyKey` on `emails.send`. A repeat within 24 hours returns the original message. A repeat with a different body, or the same key past the 24-hour window, throws a `PouchError` with `code: "idempotency_conflict"` and the original `message_id` in `detail`.

## Rate limits

Every response carries `X-RateLimit-*` headers. Read them by passing `onRateLimit` to the constructor:

```ts
const pouch = new PouchClient({
  apiKey: process.env.POUCH_API_KEY!,
  baseUrl: process.env.POUCH_URL!,
  onRateLimit: ({ limit, remaining, reset }) => {
    if (remaining !== null && remaining < 5) console.warn(`close to the limit: ${remaining}/${limit}`);
  },
});
```

A `429` throws a `PouchError` with `code: "rate_limit_exceeded"` and `retryAfter` in seconds.

## Errors

Every non-2xx response throws a `PouchError`, never a bare `Error`. It carries:

- `code` — a stable identifier, safe to switch on (`"domain_not_verified"`, `"key_not_scoped"`, ...). A response that isn't the API's documented error envelope — a proxy's 502, an HTML error page — gets `code: "sdk_unparseable_response"`, a code the API itself never sends, rather than being folded into one of its real codes.
- `message` — one sentence, for logs or a developer, not for end users
- `status` — the HTTP status code
- `field` — the offending request field, when there is one
- `detail` — structured context: the DNS records still missing, the suppression reason, and so on
- `requestId` — the response's `X-Request-Id`. Quote it when reporting a problem.
- `retryAfter` — seconds to wait, read from the response's `Retry-After` header when present (today, only on `rate_limit_exceeded`)
