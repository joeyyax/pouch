import type { Metadata } from "next";
import { Container } from "@/components/ui/container";
import { TableOfContents } from "@/components/ui/table-of-contents";
import { brand } from "@/lib/brand";
import { Logo } from "@/components/logo";
import { CODES, GLOBAL_CODES, BODY_CODES, ROUTES, routeAnchor } from "@/lib/api-docs/spec";
import { ERROR_CODES } from "@/lib/api/errors";
import {
  Card,
  MethodChip,
  Path,
  RequestFieldTable,
  ResponseFieldTable,
  RouteErrorTable,
  SectionHeading,
  SmtpReplyTable,
  StatusChip,
} from "./_components";

const SMTP_REPLIES = [
  { situation: "AUTH PLAIN with an unknown, malformed or revoked key", reply: "535 — invalid_key" },
  { situation: "The key can't send from the message's from domain", reply: "550 — key_not_scoped" },
  { situation: "A field is missing or the wrong shape (subject, an address, …)", reply: "550 — validation_failed" },
  { situation: "A recipient is suppressed", reply: "550 — recipient_suppressed" },
  { situation: "The from domain isn't added or isn't verified", reply: "550 — domain_not_verified" },
  { situation: "Attachments exceed the size limit", reply: "552 — attachment_too_large" },
  { situation: "The key's per-minute rate limit is spent", reply: "450 — rate_limit_exceeded" },
  { situation: "The service can't complete the request right now", reply: "451 — provider_unavailable" },
];

// Statically generated: every field on this page is read from the zod schemas and the route
// spec at build time (lib/api-docs/spec.ts, which fails module load — and so this page's
// prerender, and `next build` — if a schema field is missing `.describe()`, per
// docs/api/conventions.md's documentation contract). Nothing here reads a request, a cookie or
// the database, so there's no reason for this to be dynamic.
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: `API reference · ${brand.name}`,
  description: `Every endpoint, field and error the ${brand.name} API returns, generated from its request schemas.`,
};

export default function ApiReferencePage() {
  const tocItems = [
    { id: "base", label: "Base" },
    ...ROUTES.flatMap((route) =>
      route.path === "/v1/emails" && route.method === "POST"
        ? [{ id: routeAnchor(route), label: `${route.method} ${route.path}` }, { id: "smtp", label: "SMTP" }]
        : [{ id: routeAnchor(route), label: `${route.method} ${route.path}` }],
    ),
    { id: "errors", label: "Error codes" },
  ];

  return (
    <div className="pb-24">
      <Container className="pt-16 pb-12 sm:pt-24">
        <Logo className="h-9 w-9" />
        <h1 className="type-h1 mt-4 text-foreground">API reference</h1>
        <p className="type-subhead mt-4 max-w-2xl text-foreground-soft">
          Every endpoint {brand.name} serves under <code className="font-mono">/v1</code>. Generated from the zod schemas
          that validate requests, so it can&rsquo;t drift from what the API actually accepts.
        </p>
      </Container>

      <Container className="grid grid-cols-1 gap-12 lg:grid-cols-[220px_1fr]">
        <nav className="hidden lg:block">
          <div className="sticky top-24">
            <TableOfContents items={tocItems} />
          </div>
        </nav>

        <div className="flex flex-col gap-16">
          <section id="base" className="scroll-mt-24">
            <SectionHeading id="base-heading">Base</SectionHeading>
            <div className="mt-4 flex flex-col gap-3 text-foreground-soft">
              <p>
                Versioned under <code className="font-mono">/v1</code>. JSON in, JSON out, <code className="font-mono">Content-Type: application/json</code> on every response, errors included.
              </p>
              <p>
                Authenticate with <code className="font-mono">Authorization: Bearer &lt;key&gt;</code>. Every resource has
                an opaque, type-prefixed id (<code className="font-mono">dom_</code>, <code className="font-mono">msg_</code>).
              </p>
              <p>
                List endpoints take <code className="font-mono">limit</code> (default 50, max 200) and{" "}
                <code className="font-mono">cursor</code>, and return <code className="font-mono">data</code> and{" "}
                <code className="font-mono">next_cursor</code>, newest first.
              </p>
              <p>
                <code className="font-mono">invalid_key</code>, <code className="font-mono">rate_limit_exceeded</code> and{" "}
                <code className="font-mono">method_not_allowed</code> can come back from any route below; a route that
                reads a JSON body can also return <code className="font-mono">invalid_json</code> or{" "}
                <code className="font-mono">attachment_too_large</code> for an oversized body. Neither set is repeated per
                route — see <a href="#errors" className="underline underline-offset-2">error codes</a> for the full list.
              </p>
            </div>
          </section>

          {ROUTES.map((route) => (
            <section key={routeAnchor(route)} id={routeAnchor(route)} className="scroll-mt-24">
              <div className="flex flex-wrap items-center gap-3">
                <MethodChip method={route.method} />
                <Path path={route.path} />
              </div>
              <SectionHeading id={`${routeAnchor(route)}-heading`}>{route.summary}</SectionHeading>
              <p className="mt-1 text-foreground-soft">
                Auth: <span className="text-foreground">{route.auth}</span>
              </p>

              {route.request ? (
                <div className="mt-6">
                  <h3 className="type-label text-muted-foreground">Request body</h3>
                  {route.request.note ? <p className="mt-2 text-sm text-foreground-soft">{route.request.note}</p> : null}
                  <div className="mt-3">
                    <RequestFieldTable fields={route.request.fields} label={`${route.method} ${route.path} request fields`} />
                  </div>
                </div>
              ) : null}

              {route.query ? (
                <div className="mt-6">
                  <h3 className="type-label text-muted-foreground">Query parameters</h3>
                  <div className="mt-3">
                    <RequestFieldTable fields={route.query.fields} label={`${route.method} ${route.path} query parameters`} />
                  </div>
                </div>
              ) : null}

              <div className="mt-6">
                <h3 className="type-label flex items-center gap-2 text-muted-foreground">
                  Response <StatusChip status={route.response.status} />
                </h3>
                <p className="mt-2 text-sm text-foreground-soft">{route.response.description}</p>
                {route.response.note ? <p className="mt-1 text-sm text-foreground-soft">{route.response.note}</p> : null}
                <div className="mt-3">
                  <ResponseFieldTable fields={route.response.fields} label={`${route.method} ${route.path} response fields`} />
                </div>
              </div>

              <div className="mt-6">
                <h3 className="type-label text-muted-foreground">Errors this route returns</h3>
                <p className="mt-2 text-sm text-foreground-soft">
                  Plus the codes every route can return — see{" "}
                  <a href="#errors" className="underline underline-offset-2">
                    error codes
                  </a>
                  .
                </p>
                <div className="mt-3">
                  <RouteErrorTable codes={route.errors} label={`${route.method} ${route.path} error codes`} />
                </div>
              </div>
            </section>
          ))}

          <section id="smtp" className="scroll-mt-24">
            <SectionHeading id="smtp-heading">SMTP</SectionHeading>
            <p className="mt-4 text-foreground-soft">
              A door into the API for anything that only speaks SMTP — WordPress, monitoring tools, anything with a
              stock SMTP plugin. It authenticates with a key, parses the message and calls the same send path as{" "}
              <code className="font-mono">POST /v1/emails</code>. It doesn&rsquo;t queue independently and has no
              suppression logic of its own: what a caller sees over SMTP is what they&rsquo;d see over HTTP, in
              SMTP&rsquo;s vocabulary.
            </p>
            <div className="mt-4 flex flex-col gap-3 text-foreground-soft">
              <p>
                <span className="text-foreground">STARTTLS</span> on port 587. Implicit TLS on 465 isn&rsquo;t
                offered.
              </p>
              <p>
                Authenticate with <code className="font-mono">AUTH PLAIN</code>: the key id (
                <code className="font-mono">key_…</code>) as username, the key as password. The password alone
                identifies the key — the username isn&rsquo;t checked against it, so it&rsquo;s there for clients
                that require one, not a second factor.
              </p>
              <p>
                Recipients come from the message&rsquo;s <code className="font-mono">To</code> and{" "}
                <code className="font-mono">Cc</code> headers. Any <code className="font-mono">RCPT TO</code>{" "}
                address that isn&rsquo;t in either becomes a <code className="font-mono">bcc</code> — the same
                fallback a mail client uses when it strips Bcc from the headers it sends.
              </p>
              <p>
                A test-mode key (<code className="font-mono">sk_test_…</code>) behaves exactly as it does over
                HTTP: the mock provider, synthetic events, nothing reaches a real inbox.
              </p>
            </div>
            <div className="mt-6">
              <h3 className="type-label text-muted-foreground">Reply codes</h3>
              <p className="mt-2 text-sm text-foreground-soft">
                A rejection carries the same message a caller would get over HTTP, as the reply text.{" "}
                <span className="text-foreground">5xx</span> is permanent — retrying the same message won&rsquo;t
                help. <span className="text-foreground">4xx</span> is worth retrying: a rate limit or a transient
                service problem, not a message that&rsquo;s wrong.
              </p>
              <div className="mt-3">
                <SmtpReplyTable rows={SMTP_REPLIES} label="SMTP reply codes" />
              </div>
            </div>
          </section>

          <section id="errors" className="scroll-mt-24">
            <SectionHeading id="errors-heading">Error codes</SectionHeading>
            <p className="mt-4 text-foreground-soft">
              Every non-2xx response is <code className="font-mono">{"{ error: { code, message, field?, detail? } }"}</code>.{" "}
              <code className="font-mono">code</code> is stable — callers branch on it. <code className="font-mono">message</code>{" "}
              is one sentence and can change.
            </p>
            <Card className="mt-6">
              <p className="type-label text-muted-foreground">Applies to every /v1 route</p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {GLOBAL_CODES.map((code) => (
                  <li key={code} className="font-mono text-sm text-foreground-soft">
                    {code} <StatusChip status={ERROR_CODES[code]} />
                  </li>
                ))}
              </ul>
              <p className="type-label mt-4 text-muted-foreground">Applies to any route reading a request body</p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {BODY_CODES.map((code) => (
                  <li key={code} className="font-mono text-sm text-foreground-soft">
                    {code} <StatusChip status={ERROR_CODES[code]} />
                  </li>
                ))}
              </ul>
            </Card>
            <div className="mt-6">
              <RouteErrorTable codes={Object.keys(CODES) as (keyof typeof CODES)[]} label="All error codes" />
            </div>
          </section>
        </div>
      </Container>
    </div>
  );
}
