import { Chip } from "@/components/ui/chip";
import { KeyValueList, type KeyValueItem } from "@/components/ui/key-value-list";
import type { KeySmtp } from "@/lib/dashboard/views/smtp";
import { Snippet } from "../_ui/snippet";
import { Term } from "../_ui/term";
import { SMTP_DOCS_URL } from "@/lib/api-docs/links";

/** How to send with a key over SMTP. `secret` is null once it's no longer shown. */
export function SmtpDetails({
  smtp,
  keyId,
  secret,
  newTab = false,
}: {
  smtp: KeySmtp;
  keyId: string;
  secret: string | null;
  /** Links open in a new tab, for the shown-once screen. */
  newTab?: boolean;
}) {
  const { endpoint, domains, everyDomain, snippets } = smtp;

  const items: KeyValueItem[] = [
    endpoint.host
      ? { label: "Host", value: endpoint.host, copy: endpoint.host }
      : {
          label: "Host",
          value: (
            <Term definition="An admin names it with SMTP_TLS_HOST." className="text-muted-foreground">
              Not set on this install
            </Term>
          ),
          mono: false,
        },
    { label: "Port", value: String(endpoint.port), copy: String(endpoint.port) },
    {
      label: "Encryption",
      value: endpoint.tls === "starttls" ? "STARTTLS" : "None, in development only",
      mono: false,
    },
    { label: "Username", value: keyId, copy: keyId },
    secret
      ? { label: "Password", value: secret, copy: secret }
      : { label: "Password", value: <span className="text-muted-foreground">The key’s secret</span>, mono: false },
    {
      label: "Send from",
      value:
        domains.length === 0 ? (
          <span className="text-muted-foreground">No domains yet</span>
        ) : (
          <span className="flex flex-wrap items-center gap-1">
            {domains.map((domain) =>
              domain.verified ? (
                <Chip key={domain.id} tone="value">
                  {domain.name}
                </Chip>
              ) : (
                <Term key={domain.id} chip definition={`Sends from ${domain.name} fail until it’s verified.`}>
                  <Chip tone="warn" caps={false}>
                    {domain.name}, not verified
                  </Chip>
                </Term>
              ),
            )}
            {everyDomain ? (
              <Term term="every_domain" className="text-muted-foreground">
                and any added later
              </Term>
            ) : null}
          </span>
        ),
      mono: false,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <KeyValueList mono items={items} />
      <p className="type-body-sm text-foreground-soft">
        A from address on any other domain is refused. The password alone identifies the key, so any username works.
      </p>
      {snippets ? (
        <Snippet languages={snippets} label="Config format" reference={SMTP_DOCS_URL} newTab={newTab} />
      ) : null}
    </div>
  );
}
