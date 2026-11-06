# Registrar integration design

For #84. This is what has to be true before any of it is built — the security model, the reconciliation rules, and what a first version leaves out.

## Grounding

Five domains were set up by hand against Cloudflare the same morning this was written. Three things showed up that a design has to answer, not just a Cloudflare adapter:

- `example.com` carries Google Workspace MX at the apex. A tool that writes "the domain's records" without a hard scope can take down inbound mail for a company that has nothing to do with Pouch.
- `example.org` still carries a MAIL FROM MX pointing at SES us-east-1 and DKIM selectors for two providers it moved off months ago. All of it is still there. Nothing broke by leaving it.
- SPF only tolerates one record per name. `DnsRecord.merge === "spf"` exists because Pouch already knows this from the guided-setup diff (#83, #200).

Those three facts set the rules below: touch only what we wrote, never touch SPF except by merge, and prove both in code, not in a comment.

## Providers, and order

Cloudflare first. It's the provider this was validated against, its API is a clean zone/record model, and zone-scoped tokens give the option of least privilege from day one.

Route53 second, written by us rather than waiting on a contributor. #84 already makes this argument: a port with one implementation is that implementation with extra steps, and provider-agnostic is a claim only a second, independent adapter can back up. Mailpace stays configured on the sending side for the same reason.

Both live behind a `DnsProvider` port, the same shape as `Adapter` in `lib/providers/adapters/types.ts`:

```ts
interface DnsProviderCapabilities {
  apexCname: boolean;      // can an apex hold a CNAME (flattened or native)
  nsWritable: boolean;     // can this adapter touch NS records at all (it won't, but the flag says whether the API could)
  zoneEnumeration: boolean; // can a provider-scoped credential list zones
}

interface DnsZone {
  name: string;   // the zone's DNS name — never a provider zone id past the adapter boundary
  id: string;     // provider-internal, opaque outside the adapter
}

interface DnsProvider {
  readonly adapter: string;
  readonly capabilities: DnsProviderCapabilities;
  listZones(): Promise<DnsZone[]>;              // throws NotSupported when the token can't enumerate
  findZone(domain: string): Promise<DnsZone | null>;
  getRecords(zone: DnsZone, name?: string): Promise<DnsRecord[]>;
  upsertRecords(zone: DnsZone, records: DnsRecord[]): Promise<DnsWriteResult[]>;
  removeRecords(zone: DnsZone, records: DnsRecordRef[]): Promise<void>;
  healthCheck(): Promise<AdapterHealth>;
}
```

`DnsRecord` is the type that already exists in `lib/providers/adapters/types.ts` — no second record shape. A mock adapter ships alongside Cloudflare, same as `lib/providers/adapters/mock.ts` does for sending.

## The credential

**Storage.** A DNS provider account is its own row, encrypted the same way as `providers` (`lib/providers`), not a field bolted onto an email provider — a domain's send path and its DNS write path are different blast radii and shouldn't share a table. One per organization to start; the schema allows more than one so an operator with domains split across two Cloudflare accounts isn't blocked later.

**Verification before storage.** Same rule as email credentials (`docs/decisions.md`, "Credentials are verified before they're stored"): a token that can't read at least one zone is refused at creation, never stored broken.

**Scope.** Both token shapes are supported, because requiring the broader one to use the feature at all is the wrong trade:

- **Zone-scoped** (`Zone:DNS:Edit` on one zone) — least privilege, can't list zones. The domain name is typed, not picked, and `findZone` is the only zone call this credential can make.
- **Provider-scoped** (`Zone:DNS:Edit` + `Zone:Zone:Read` across the provider) — enables `listZones`, so the UI can offer a picker. Still only ever touches zones that match a domain Pouch already knows about; nothing calls `upsertRecords` against a zone with no corresponding Pouch domain, enumerable or not.

No global API key, ever — rejected at the credential-parsing step before a network call is made, not just left out of the docs. Cloudflare doesn't accept a global key on newer endpoints anyway, so this is a real refusal, not a formality.

**Revocation.** DNS write is additive tooling layered on top of a flow that already works by hand (#83). A domain's sending, verification and event handling never read this credential — only the "write records for me" button does. When the token is revoked, `healthCheck` (same shape as provider `healthCheck`, on the same slow-probe interval) starts reporting `ok: false`, the button surfaces that instead of attempting a write, and nothing about the domain's mail flow changes. Losing this credential degrades a convenience, never sending.

## The permission model, enforced rather than documented

Three backstops, each one closing a way the "intention" could be bypassed by a bug rather than a malicious caller:

1. **Only our own proposed records reach the write path.** There is no freeform "edit this zone" surface anywhere in the API or dashboard. The only records ever handed to `upsertRecords` are the ones an `Adapter.domain.create()` or `verify()` call already returned for that specific domain — the same records the plain-copy flow in #83 renders. A caller can't construct an arbitrary `DnsRecord` and get it written; the write function takes a domain id and computes its own record set server-side.
2. **Every record is checked against the domain's current required set before it's written**, even though (1) already constrains where records come from. Belt and suspenders: if a future bug ever let an unexpected record reach `upsertRecords`, this second check still throws rather than write it.
3. **Deletion only ever targets provenance we hold**, keyed by `(organization_id, domain_id, provider_id, type, name)` — see provenance below — and re-reads the live value immediately before deleting it, refusing the delete if it no longer matches what we wrote. A record we wrote that someone has since hand-edited is no longer safe to remove blind.

None of this is "the UI only shows a button for the right thing." All three are checks the write function itself performs, so a bug in the UI can't turn into a write outside these bounds.

### Provenance

A new table, `dns_provider_records`: `organization_id`, `domain_id`, `dns_provider_account_id`, `zone_name`, `type`, `name`, `written_value` (the exact value written — for a merged SPF record, the *mechanisms we added*, not the whole record), `applied_at`. This is what answers "is this ours" without guessing from shape. Nothing is ever deleted, edited, or treated as ours because it *looks* like something Pouch would write — only because a row says we wrote it.

## Read-before-write, and how it differs from #190

#190 reads live DNS through public resolvers (1.1.1.1, 8.8.8.8) for display: an independent, unauthenticated view of what the internet sees, deliberately decoupled from whether Pouch trusts its own write. That stays exactly as it is and keeps being the verification of record after a write — a plan reporting "applied" and #190 still showing "different" a few minutes later is expected (propagation, caching) and is the reason #190's panel exists as a second, independent check rather than the write path just marking itself done.

The write path reads differently: it calls `getRecords` on the provider's own API, authoritative and uncached, because the two failure modes it has to avoid — double-writing over a stale public-resolver read, and refusing to write into a record that's only mid-propagation — can't be resolved from a resolver that's sometimes stale by design.

**The plan**, for each required record:

| Live zone state at (type, name) | Action |
|---|---|
| Nothing there | Create |
| Exactly what we'd write already (normalized: case, trailing dot) | No-op, shown as already correct |
| An SPF record at the name, and this record's `merge === "spf"` | Merge: append only the missing mechanisms (`lib/domains/spf.ts#spfMergeGuidance`) to the existing value. Never touch a mechanism already there. If appending would exceed `SPF_LOOKUP_LIMIT`, this is a conflict, not a merge. |
| Anything else at the name that doesn't match | Conflict — never written. Reported like #83's diff, with the observed value, and a "this needs your DNS provider directly" fallback to the plain record list. |
| More than one record already at the name, and this one's value is among them | No-op, shown as already correct. The record set's other values (a second MX, an unrelated TXT) are somebody else's and stay untouched either way. |
| More than one record already at the name, and this one's value isn't among them | Conflict, same as above — adding a new value alongside others needs a read-modify-write no adapter does, so this stays a stop rather than a guessed write |

A conflict is a stop, never a best-effort overwrite. The plan for the rest of the domain's records still runs — one record needing a human doesn't block the others that don't.

Route53 models several values under one (name, type) as a record set; Cloudflare models each value as its own record. The "already correct" row above is what makes a correctly configured Route53 zone (two mail exchangers, two independent TXT records at one name) stop reading as a conflict for reasons unrelated to anything being wrong — see #232.

## Failure and partial application

Every write this design makes is additive: a new record, or mechanisms appended to an existing SPF value. Nothing is ever replaced or deleted on the write path, so there's no meaningful "undo" — reverting a correctly-added record is strictly riskier than leaving it, and leaving it is harmless because it's either new or exactly what SPF needed anyway.

So the model is a checklist, not a transaction. A plan is a list of steps, each with a status: `pending`, `applied`, `skipped` (already correct), `conflict` (needs a human), `failed` (provider call errored — rate limit, transient network, expired token). Steps apply in order; a step's own failure doesn't stop the rest, so five records with the third one rate-limited still land the other four.

The domain screen shows this per record, in the same list #83 already renders — not a separate progress bar. "4 of 5 applied. `dkim._domainkey` failed: rate limited by Cloudflare. Retry." Retrying re-runs the plan; the four `applied`/`skipped` steps are no-ops the second time, so retry is just "run the plan again," the same idempotence #84's acceptance criteria already call for.

Verification is unaffected by any of this: `provider.domain.verify()` is still the only thing that marks a domain verified, on its own loop, exactly as today. Applying DNS records is a way to make that loop return true sooner, never a shortcut around it.

## Domain removal and provider moves

**Removing a domain.** The provenance table makes "remove only what we wrote" a query instead of a guess, but removal is a separate, explicit action from delete — a confirm step of its own, not folded silently into "delete this domain." A merged SPF record is removed by subtracting exactly the mechanisms recorded in `written_value`, using the same merge engine in reverse; if that leaves the record with mechanisms Pouch didn't add, the record stays, edited, not deleted. Automatic cleanup on domain delete is explicitly out of scope for v1 — see below.

**Provider-provider moves.** `docs/decisions.md`'s "staged cutover, never an immediate rebind" already governs this at the domain layer: a pending binding holds until the new provider verifies, and the domain keeps sending on the old one throughout. DNS integration follows the same shape rather than inventing a second one — the new provider's required records are added (or merged) during the pending period, alongside whatever the old provider still has published. This can mean two MX or two DKIM CNAME sets coexisting at different names for the duration, which is the same collision surface the guided setup already warns about (two providers wanting `mail.<domain>`); this design doesn't add a new failure mode there, it inherits the existing one.

Once cutover completes, the old provider's provenance-tracked records are stale but not touched automatically — they're offered as a dismissible "clean up N records from the previous provider" action the operator confirms, mirroring domain removal's cleanup step. Automatic removal on cutover is out of scope for the same reason it's out of scope on domain delete: a silent delete right after a stated principle of "we don't delete what looks stale" would be the exact thing this design exists to rule out.

## `/v1` or dashboard-only

Dashboard-only for the whole of this design. `docs/decisions.md`'s "Management is the one place a caller sees providers" already draws sending and management apart; this sits further back than ordinary management, since it's the one integration that can rewrite DNS outside Pouch's own sending path entirely. #190's live-DNS work made the same call for its read side. A `/v1/dns_provider_accounts` surface is a plausible later slice once the dashboard flow has run in production and the write path has a track record — not part of a first version, and not blocking the DNS provider account or credential schemas from being built in a way that would support it later.

## Out of scope for v1

- Automatic cleanup of stale or previous-provider records, on removal or on cutover — always an explicit, confirmed action.
- Zone or NS delegation changes of any kind.
- Any registrar beyond Cloudflare and Route53.
- CAA, DMARC or any record type Pouch doesn't already require for sending.
- A `/v1` surface for DNS provider accounts or applying records.
- Bulk / cross-domain DNS import or migration tooling.
- More than one DNS provider account per organization (the schema allows it; the UI doesn't offer it yet).

## What would change this

- If a registrar's API turns out not to support authoritative, uncached reads (Route53 is expected to; verify before building it), the read-before-write table above needs a provider-specific caveat.
- If SPF merge conflicts turn out to be common rather than rare, the "always stop, never overwrite" rule is still right, but the fallback UI (plain record list) may need to become the primary path for that record type rather than a fallback.
- If an operator ever needs more than one DNS provider account per organization in practice, the schema doesn't change — only the UI restriction goes away.
