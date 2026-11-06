/** SMTP connection details the keys screens render. Client-safe, like the rest of views/. */
import type { SnippetLanguage } from "@/lib/dashboard/curl";
import type { KeyDomainOption } from "@/lib/dashboard/views/keys";

export interface SmtpEndpoint {
  /** Null when the install doesn't name its SMTP host. */
  host: string | null;
  port: number;
  tls: "starttls" | "none";
}

export interface KeySmtp {
  endpoint: SmtpEndpoint;
  /** Domains the key can send from. */
  domains: KeyDomainOption[];
  /** Scoped to every domain, including ones added later. */
  everyDomain: boolean;
  /** Null without a host. */
  snippets: SnippetLanguage[] | null;
}
