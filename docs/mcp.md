# MCP server

A streamable HTTP [MCP](https://modelcontextprotocol.io) endpoint at `POST /mcp`, one tool per
exposed `/v1` route. It's a wrapper, not a second implementation: every tool call constructs the
same `Request` an HTTP caller of that route would send and calls that route's own exported
handler in-process — same validation, same key scoping, same errors. See `docs/api/conventions.md`
for what each route actually does; this page only covers what's different about reaching it
through MCP.

## Connecting

```
POST https://<host>/mcp
Authorization: Bearer <key>
Content-Type: application/json
Accept: application/json, text/event-stream
```

The endpoint is stateless: every request gets a fresh MCP session, so there's no `initialize`
handshake to hold open between calls. Authentication, rate limiting and `X-Request-Id` all go
through the same `withApiKey` wrapper `/v1` routes use — a tool call and an HTTP call to the same
route are charged against the same per-key rate limit, as two separate hits: one for the MCP
request itself, one for the `/v1` call the tool makes underneath it.

`GET` and `DELETE` are accepted for MCP's own session-stream and session-termination semantics;
neither does anything Pouch-specific, since there's no session state to stream or terminate.

## Tools

`lib/mcp/registry.ts` pairs each tool with a `RouteSpec` from `lib/api-docs/spec.ts` — the same
generator #4/#61 built for the API reference — and the same zod schema the route parses its
request with. A tool's description, input shape and error list are generated from those, not
retyped by hand. The registry throws at load if a tool names a route `lib/api-docs/spec.ts`
doesn't document. The reverse is checked too: `tests/unit/mcp-coverage.test.ts` fails when a
documented route has no tool, unless its `NO_TOOL` list names the route with a reason.

**Every documented route has a tool** apart from the three in "No tool" below. A route is never
left out because it's destructive: the key that authenticates a tool call is the same key that would
authenticate a direct HTTP call, so the MCP wrapper adds no privilege and removes none.

Destructiveness is expressed, not enforced, through MCP's own [tool
annotations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#annotations):
every tool carries `readOnlyHint`, `destructiveHint` and `idempotentHint`, set honestly per route
in `lib/mcp/registry.ts`. `destructiveHint: true` is set on every delete, on both unsubscribes (no API call resubscribes
an address), on `update_domain_inbound`, since every call with `webhook_url` issues a new
signing secret, on `suspend_organization`, since a manual suspension fails queued mail, and on
`convert_admin_provider`, which is undone only by hand in SQL and AWS. A client that wants to prompt or confirm on that has what it needs to.
If a delete route needs a guard beyond what `/v1` already has — a confirmation step, a soft
delete, a refusal when the domain has sent recently — that's a change to `/v1` itself, so every
caller gets it, not something bolted onto this wrapper for MCP callers alone.

| Tool | Route | Annotations |
|---|---|---|
| `create_domain` | `POST /v1/domains` | — |
| `list_domains` | `GET /v1/domains` | read-only |
| `read_domain` | `GET /v1/domains/:id` | read-only |
| `move_domain` | `PATCH /v1/domains/:id` | idempotent |
| `verify_domain` | `POST /v1/domains/:id/verify` | idempotent |
| `delete_domain` | `DELETE /v1/domains/:id` | **destructive**, idempotent |
| `read_reputation` | `GET /v1/reputation` | read-only |
| `read_stats` | `GET /v1/stats` | read-only |
| `send_email` | `POST /v1/emails` | — |
| `list_emails` | `GET /v1/emails` | read-only |
| `read_email` | `GET /v1/emails/:id` | read-only |
| `resend_email` | `POST /v1/emails/:id/resend` | — |
| `watch_email` | `GET /v1/emails/:id/events` | read-only |
| `list_providers` | `GET /v1/providers` | read-only |
| `read_provider` | `GET /v1/providers/:id` | read-only |
| `import_suppressions` | `POST /v1/suppressions` | idempotent |
| `list_suppressions` | `GET /v1/suppressions` | read-only |
| `read_suppression` | `GET /v1/suppressions/:address` | read-only |
| `remove_suppression` | `DELETE /v1/suppressions/:address` | **destructive**, idempotent |
| `read_recipient` | `GET /v1/recipients/:address` | read-only |
| `create_export` | `POST /v1/exports` | — |
| `list_exports` | `GET /v1/exports` | read-only |
| `read_export` | `GET /v1/exports/:id` | read-only |
| `create_list` | `POST /v1/lists` | — |
| `list_lists` | `GET /v1/lists` | read-only |
| `read_list` | `GET /v1/lists/:id` | read-only |
| `delete_list` | `DELETE /v1/lists/:id` | **destructive**, idempotent |
| `add_list_member` | `POST /v1/lists/:id/members` (one address) | idempotent |
| `import_list_members` | `POST /v1/lists/:id/members` (`members` array) | idempotent |
| `list_list_members` | `GET /v1/lists/:id/members` | read-only |
| `remove_list_member` | `DELETE /v1/lists/:id/members/:memberId` | **destructive**, idempotent |
| `export_list_members` | `GET /v1/lists/:id/export` | read-only |
| `unsubscribe_from_list` | `POST /v1/lists/:id/unsubscribe` | **destructive**, idempotent |
| `unsubscribe_from_domain` | `POST /v1/domains/:id/unsubscribe` | **destructive**, idempotent |
| `send_batch` | `POST /v1/batches` | — |
| `read_batch` | `GET /v1/batches/:id` | read-only |
| `list_inbound` | `GET /v1/inbound` | read-only |
| `read_inbound` | `GET /v1/inbound/:id` | read-only |
| `read_domain_inbound` | `GET /v1/domains/:id/inbound` | read-only |
| `update_domain_inbound` | `PATCH /v1/domains/:id/inbound` | **destructive** |
| `list_dmarc_reports` | `GET /v1/domains/:id/dmarc_reports` | read-only |
| `create_address` | `POST /v1/addresses` | — |
| `list_addresses` | `GET /v1/addresses` | read-only |
| `read_address` | `GET /v1/addresses/:id` | read-only |
| `update_address` | `PATCH /v1/addresses/:id` | — |
| `revoke_address` | `DELETE /v1/addresses/:id` | **destructive**, idempotent |
| `list_address_messages` | `GET /v1/addresses/:id/messages` | read-only |
| `wait_for_mail` | `GET /v1/addresses/:id/messages` (`wait`, 55s by default) | read-only |
| `reply_from_address` | `POST /v1/addresses/:id/reply` | — |
| `add_forward_target` | `POST /v1/addresses/:id/forward_targets` | — |
| `list_forward_targets` | `GET /v1/addresses/:id/forward_targets` | read-only |
| `read_forward_target` | `GET /v1/addresses/:id/forward_targets/:targetId` | read-only |
| `remove_forward_target` | `DELETE /v1/addresses/:id/forward_targets/:targetId` | **destructive**, idempotent |
| `resend_forward_confirmation` | `POST /v1/addresses/:id/forward_targets/:targetId/resend_confirmation` | — |
| `create_key` | `POST /v1/keys` | — |
| `list_keys` | `GET /v1/keys` | read-only |
| `read_key` | `GET /v1/keys/:id` | read-only |
| `update_key` | `PATCH /v1/keys/:id` | idempotent |
| `revoke_key` | `DELETE /v1/keys/:id` | **destructive**, idempotent |
| `create_webhook_endpoint` | `POST /v1/webhook_endpoints` | — |
| `list_webhook_endpoints` | `GET /v1/webhook_endpoints` | read-only |
| `read_webhook_endpoint` | `GET /v1/webhook_endpoints/:id` | read-only |
| `update_webhook_endpoint` | `PATCH /v1/webhook_endpoints/:id` | idempotent |
| `delete_webhook_endpoint` | `DELETE /v1/webhook_endpoints/:id` | **destructive**, idempotent |
| `rotate_webhook_secret` | `POST /v1/webhook_endpoints/:id/rotate_secret` | **destructive**, idempotent |
| `list_webhook_deliveries` | `GET /v1/webhook_endpoints/:id/deliveries` | read-only |
| `read_webhook_delivery` | `GET /v1/webhook_endpoints/:id/deliveries/:deliveryId` | read-only |
| `list_activity` | `GET /v1/activity` | read-only |
| `read_activity` | `GET /v1/activity/:id` | read-only |
| `read_organization` | `GET /v1/organization` | read-only |
| `update_organization` | `PATCH /v1/organization` | idempotent |

Providers are read-only for organization keys, so they have no create, update, test or delete tools.

The key, endpoint, activity and organization tools need a key with no domain scope, and `create_key` mints
only in the calling key's own mode. Minting an admin key has no tool and no route — see
docs/decisions.md.

`POST /v1/lists/:id/members` takes two JSON shapes, so it has two tools. Its CSV body has no
tool; `import_list_members` takes the same rows as JSON.

`export_list_members` returns the CSV as the result's text, with no `structuredContent`.
`_meta.content_type` carries the route's `content-type`.

`send_email` takes `sensitive`, as `POST /v1/emails` does. `read_email` and `list_emails` never return a sensitive message's body, whatever `include` names; `list_emails` takes `sensitive: "true"` to list only those messages.

## Admin tools

An admin key (`docs/api/admin.md`) gets the tools below. It belongs to no organization, so an ordinary tool answers `403 organization_key_required`. `buildMcpServer` registers a tool marked `admin: true` only when the key's scope is `admin`, so no other key sees them in `tools/list` or can call them by name. The route refuses any other key with `admin_key_required` regardless.

| Tool | Route | Annotations |
|---|---|---|
| `list_admin_providers` | `GET /v1/admin/providers` | read-only |
| `read_admin_provider` | `GET /v1/admin/providers/:id` | read-only |
| `create_admin_provider` | `POST /v1/admin/providers` | — |
| `update_admin_provider` | `PATCH /v1/admin/providers/:id` | idempotent |
| `test_admin_provider` | `POST /v1/admin/providers/:id/test` | read-only |
| `setup_admin_provider` | `POST /v1/admin/providers/:id/setup` | idempotent |
| `read_admin_conversion` | `GET /v1/admin/providers/:id/convert` | read-only |
| `convert_admin_provider` | `POST /v1/admin/providers/:id/convert` | **destructive**, idempotent |
| `delete_admin_provider` | `DELETE /v1/admin/providers/:id` | **destructive**, idempotent |
| `adopt_admin_domain` | `POST /v1/admin/domains` | — |
| `list_provider_organizations` | `GET /v1/admin/providers/:id/organizations` | read-only |
| `assign_organization` | `POST /v1/admin/providers/:id/organizations` | idempotent |
| `unassign_organization` | `DELETE /v1/admin/providers/:id/organizations/:organizationId` | **destructive**, idempotent |
| `list_admin_organizations` | `GET /v1/admin/organizations` | read-only |
| `read_admin_organization` | `GET /v1/admin/organizations/:id` | read-only |
| `update_admin_organization` | `PATCH /v1/admin/organizations/:id` | idempotent |
| `suspend_organization` | `POST /v1/admin/organizations/:id/suspend` | **destructive**, idempotent |
| `release_organization` | `POST /v1/admin/organizations/:id/release` | idempotent |
| `create_admin_organization` | `POST /v1/admin/organizations` | — |
| `list_organization_members` | `GET /v1/admin/organizations/:id/members` | read-only |
| `update_organization_member` | `PATCH /v1/admin/organizations/:id/members/:userId` | idempotent |
| `remove_organization_member` | `DELETE /v1/admin/organizations/:id/members/:userId` | **destructive**, idempotent |
| `list_admin_users` | `GET /v1/admin/users` | read-only |
| `read_admin_user` | `GET /v1/admin/users/:id` | read-only |
| `update_admin_user` | `PATCH /v1/admin/users/:id` | **destructive**, idempotent |
| `delete_admin_user` | `DELETE /v1/admin/users/:id` | **destructive**, idempotent |

`update_admin_user` is marked destructive because revoking the admin flag revokes the admin keys
that account created — including the key making the call. `remove_organization_member` isn't:
it removes one membership and leaves the account and its keys alone.

`convert_admin_provider` returns once the run has started. Call `read_admin_conversion` until `conversion.state` is `done` or `failed`.

`tests/unit/mcp-coverage.test.ts` fails when an `/v1/admin` route has no tool, or when a tool's `admin` flag doesn't match its path.

## Watching a message

`watch_email` wraps `GET /v1/emails/:id/events`, the SSE route `docs/api/conventions.md` describes
under "Watching a message: webhooks vs. the stream". A held-open stream has no completed
`Response` for `lib/mcp/invoke.ts`'s request/response pattern to return, so this tool doesn't
follow it: `lib/mcp/watch.ts`'s `invokeWatchTool` still calls the same route handler — same
validation, same key scoping, same errors, same concurrent-stream slot from
`MAX_CONCURRENT_STREAMS_PER_KEY` — but reads the SSE frames it writes instead of returning them
to the caller as a stream, and folds them into one `CallToolResult`.

**The call blocks, then returns.** Up to `MCP_WATCH_TIMEOUT_MS` (55s by default, comfortably under
the tool-call timeout most MCP clients enforce around 60s), it waits for the message to reach a
terminal state — `delivered`, `bounced`, `complained` or `failed`. The result is always
`{ finished, message, events }`: `message` is the message in the same shape `GET /v1/emails/:id`
returns, `events` lists the transitions seen during the call, and `finished` says whether that
happened because the message settled or because time ran out. A timeout is not an error —
`isError` is `false` and `finished` is `false`, with a `note` saying to call it again. There's no
`Last-Event-ID` for a tool call to send back, so a follow-up call replays the message's full
event history from the start rather than resuming — cheap for one message's events, and the
same replay an HTTP caller gets on a fresh connect with no `Last-Event-ID` of its own.

**`GET /v1/events` has no tool.** It streams every transition the key can see, held open until the
client closes it — there's no terminal state to block until, so the "wait, then return one
result" shape `watch_email` uses doesn't apply, and blocking a tool call until a caller-chosen
cutoff would just be `list_emails` with extra steps. This is deliberate, not a gap: a caller that
wants to tail everything reaches it over HTTP directly, the same as before MCP existed.

## Include and fields

Every tool over a resource read takes `fields` as an array, and `include` where the route has expansions, with the valid names in the tool's input schema. `read_email` with `fields: ["status"]` returns `id` and `status` and nothing else. The rules are the API's (`docs/api/conventions.md`, "Include and fields").

## Waiting for mail

`wait_for_mail` is `GET /v1/addresses/:id/messages` with `wait` set, through the ordinary
request/response path: the route itself long-polls, so there's no stream to fold. It returns the
page as soon as mail reaches the address, or an empty `data` once `wait` seconds pass (55 by
default, under the common 60-second tool-call timeout). Pass `after` with the last message seen to
wait for the next one. It holds one of the key's `MAX_CONCURRENT_STREAMS_PER_KEY` slots while it
waits. Read a message in full with `read_inbound`.

## Key scoping

A key's `domainIds` constrains a tool call exactly the way it constrains the same HTTP route —
`GET /v1/domains` already filters to the key's domains (`lib/domains/index.ts`'s `listDomains`),
and a scoped key already gets `key_not_scoped` back from `POST /v1/domains` and both
`/v1/providers` routes (`lib/domains/index.ts`, `lib/providers/index.ts`). The MCP layer adds nothing to
that — it can't, since every call is the same route call. What it adds is honesty in the tool
list itself: each tool's description is regenerated per connection and states the authenticating
key's actual scope — "scoped to N domains: dom_…" or "not domain-scoped" — plus, for a route
`docs/api/conventions.md` restricts to an unscoped key, whether this key qualifies. A client
reading the tool list never has to guess whether a tool reaches more than this key can reach.

## Errors

A non-2xx route response is already `docs/api/conventions.md`'s error envelope —
`{ error: { code, message, field, detail, request_id } }` — and that JSON is carried through
unchanged as the tool's error result (`isError: true`, the envelope as the result's text and
`structuredContent`). A caller sees exactly what an HTTP caller of the same route would have
seen: the same `code` to branch on, the same `message`, the same `request_id` to quote. The one
divergence: a malformed call — wrong type, missing required field — can be rejected by MCP's own
schema validation before the route ever runs, since the tool's input schema is the route's own
zod schema. That rejection isn't wrapped in the API's error envelope; it's MCP's own validation
error, over the same field names and the same shape rules.

## No tool

`tests/unit/mcp-coverage.test.ts` lists these, each with its reason.

- `POST /v1/confirm` and `POST /v1/unsubscribe` take a token rather than a key.
- `GET /v1/events` has no terminal state to wait for. See "Watching a message".
