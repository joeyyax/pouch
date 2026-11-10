import type { z } from "zod";

export interface OutboundAddress {
  name: string | null;
  address: string;
}

export interface OutboundAttachment {
  filename: string;
  /** Base64-encoded content. */
  content: string;
  contentType: string;
}

export interface OutboundMessage {
  /** The service's own message id, for correlation in provider logs. */
  id: string;
  from: OutboundAddress;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  html: string | null;
  text: string | null;
  headers: Record<string, string>;
  tags: string[];
  attachments: OutboundAttachment[];
}

/**
 * Why a send failed, and what the worker should do about it.
 * `permanent` fails the message, `transient` retries it, `backoff` pauses the whole account.
 */
export type FailureKind = "permanent" | "transient" | "backoff";

export type Receipt =
  | { successful: true; providerMessageId: string }
  | {
      successful: false;
      /** Provider reasons, verbatim. */
      errors: string[];
      failure: FailureKind;
      retryAfterSeconds?: number;
      /** A backoff that holds every tenant of a shared account, not only the one that sent. */
      accountWide?: boolean;
      /** Setup the provider no longer has. Merging `settings` makes setup run again. */
      lostSetup?: LostSetup;
    };

export interface LostSetup {
  /** What's gone, in words: "configuration set", "tenant". */
  resource: string;
  settings: ProviderSettings;
}

export type DnsRecordType = "TXT" | "CNAME" | "MX";

interface DnsRecordFields {
  type: DnsRecordType;
  name: string;
  value: string;
  /** Set on MX records. */
  priority?: number;
}

/**
 * A record a provider proposes — what it asks for to verify a domain. Never read back from a
 * live zone; see `ObservedDnsRecord` for that.
 */
export interface ProposedDnsRecord extends DnsRecordFields {
  /**
   * Set when the name may already hold a record of this kind and the two have to become one.
   * A name resolves to `permerror` with two SPF records, which fails SPF for all of that
   * domain's mail, so an adapter putting SPF at the apex marks it.
   */
  merge?: "spf";
  /**
   * Whether the domain fails to verify without this record. Follows what the adapter's own
   * `verify` actually gates on, not a per-record guess — SES's DKIM CNAMEs are required and its
   * MAIL FROM MX/TXT aren't, since `verified` there keys off DKIM alone.
   */
  required: boolean;
}

/**
 * A record read back from a live zone. Has no `required` — that describes what a provider
 * proposes, and a record already published in a zone has nothing left to propose. Carries
 * whatever the provider's API returns that identifies this exact record, for a later write
 * (#210/#211) to address it rather than one that merely matches by shape.
 */
export interface ObservedDnsRecord extends DnsRecordFields {
  /**
   * Provider-internal id. Opaque outside the adapter, and only as precise as the provider can be:
   * Cloudflare models one value as one record, so this names that exact record. Route53 models
   * several values under one (name, type) record set with no id of its own for a value or the
   * set, so its adapter synthesizes `type:name` and every value in a multi-value set shares it —
   * this can't tell two Route53 values at the same name apart. Nothing outside an adapter's own
   * `upsertRecords` reads this today; `dns-cleanup.ts` addresses records by `(type, name)` and a
   * re-read live value, never by `id`. Splitting this into a set id and a value id is worth doing
   * the day a caller actually needs to tell two values at one name apart — not before.
   */
  id: string;
}

export interface VerificationStatus {
  /**
   * Whether the provider stated where verification stands. A failed call, or an answer the adapter
   * can't read as one, is false and leaves the stored status alone.
   */
  answered: boolean;
  verified: boolean;
  /** Records the provider still can't see. */
  missing: ProposedDnsRecord[];
  errors: string[];
}

export interface CreatedDomain {
  providerDomainId: string | null;
  records: ProposedDnsRecord[];
}

/** An identity that was already at the provider, now owned by the row that adopted it. */
export interface AdoptedDomain extends CreatedDomain {
  /** Whether the provider already sends for this domain. */
  sending: boolean;
  /** The signing keys the identity kept. Empty when the provider named none. */
  dkimTokens: string[];
  /** The MAIL FROM domain the identity already had, or null when adoption set one. */
  existingMailFromDomain: string | null;
}

export interface NormalizedEvent {
  providerMessageId: string;
  /** The provider's own event id, so a retried webhook applies once. Null when it doesn't send one. */
  providerEventId: string | null;
  status: "sent" | "delivered" | "deferred" | "bounced" | "complained" | "failed";
  reason: string | null;
  /** The provider's bounce classification, as `Type/SubType`. Absent when it has none. */
  bounceType?: string | null;
  occurredAt: Date;
  detail: Record<string, unknown>;
  /** Addresses the event is about. Empty when the provider doesn't name them. */
  recipients: string[];
}

export interface NormalizedInboundAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

/** What the provider's scanners made of a message, lowercased: `pass`, `fail`, `gray`, `processing_failed`. */
export interface InboundVerdicts {
  spam: string | null;
  virus: string | null;
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
}

/** One piece of mail a domain received, normalized from whichever provider delivered it. */
export interface NormalizedInboundMessage {
  /** Provider's own id for this item. Null when it doesn't send one. */
  providerMessageId: string | null;
  from: OutboundAddress;
  /** Every recipient the provider delivered this to on the domain's inbound route. */
  to: string[];
  subject: string;
  text: string | null;
  html: string | null;
  headers: Record<string, string>;
  /** The `Message-Id` header, verbatim. Null when the sender didn't send one. */
  messageId: string | null;
  /** The `In-Reply-To` header, verbatim. Null when this isn't a reply to anything. */
  inReplyTo: string | null;
  attachments: NormalizedInboundAttachment[];
  /** The message as received, when the provider hands it over. */
  raw: Buffer | null;
  /** Null when the provider doesn't scan. */
  verdicts: InboundVerdicts | null;
}

/** Where a domain's inbound mail lands and who it's for. */
export interface InboundRoute {
  domainId: string;
  /** The full host mail is addressed to, `<subdomain>.<domain>`. */
  host: string;
}

/** Mail a provider stored and announced on its event channel, rather than posting whole. */
export interface ReceivedMail {
  /** The route's `domainId`, as the provider echoed it back. */
  domainId: string;
  providerMessageId: string;
  /** Envelope recipients on the route. Empty when only the stored message is known, as on a replay. */
  recipients: string[];
  /** Null when the announcement didn't carry them. */
  verdicts: InboundVerdicts | null;
  /** Reads the provider's stored copy. Null when it's gone. */
  read(): Promise<Buffer | null>;
  /** Deletes the provider's stored copy. */
  discard(): Promise<void>;
}

/** Thrown by `inbound.open` when the provider account isn't set up to receive. */
export class InboundUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboundUnavailableError";
  }
}

/** What an adapter did with a control message, for the receiver's response and the log. */
export interface ControlOutcome {
  handled: boolean;
  action: string | null;
  /** Non-secret config the receiver should store on the provider. */
  settings?: Record<string, string>;
}

export interface SignedRequest {
  rawBody: string;
  headers: Record<string, string>;
}

export interface AdapterCapabilities {
  /** Whether the provider can carry caller-supplied headers on a send. */
  customHeaders: boolean;
  /** Largest total decoded attachment size the provider accepts, in bytes. */
  maxAttachmentBytes: number;
  /** Largest number of recipients (to + cc + bcc) the provider accepts on one send. */
  maxRecipients: number;
  /** Whether the provider has a dedicated bulk/batch send API. */
  bulk: boolean;
  /** Whether a sending domain can be created through the provider's API. */
  domainsViaApi: boolean;
  /** Whether the provider's API returns the DNS records the domain needs. */
  dnsRecordsViaApi: boolean;
  /** Whether the event webhook can be registered through the provider's API. */
  webhooksViaApi: boolean;
  /** Whether a sending domain can be removed through the provider's API. */
  removalViaApi: boolean;
  /**
   * Whether an identity the provider already holds, and Pouch didn't create, can be taken over
   * through the provider's API without recreating it.
   */
  adoptionViaApi: boolean;
  /**
   * Whether sending credentials are in hand without a visit to the provider's console. True when
   * the account's own credential sends for every domain; false when each domain needs its own
   * token copied out of the dashboard.
   */
  credentialsWithoutConsole: boolean;
  /** Whether one provider can serve several organizations, isolated from each other at the provider. */
  sharing: boolean;
  /** Whether mail from a verified domain's subdomains sends and carries the domain's DKIM signature. */
  subdomainSending: boolean;
}

/** The yes-or-no capabilities. `maxRecipients` and friends aren't questions assertCan can ask. */
export type AdapterCapabilityFlag = {
  [K in keyof AdapterCapabilities]: AdapterCapabilities[K] extends boolean ? K : never;
}[keyof AdapterCapabilities];

/** A step the vendor console still has to do, because the provider's API can't. */
export interface SetupStep {
  step: "domain" | "dns_records" | "verification" | "webhooks" | "credentials" | "removal";
  message: string;
}

export interface Adapter {
  /** Adapter key. Matches providers.adapter. */
  readonly adapter: string;
  readonly capabilities: AdapterCapabilities;
  send(message: OutboundMessage): Promise<Receipt>;
  domain: {
    create(name: string): Promise<CreatedDomain>;
    verify(name: string, providerDomainId: string | null): Promise<VerificationStatus>;
    /**
     * Takes over an identity the provider already holds: tags it for this row's owner and
     * attaches it, keeping its existing signing keys so sending never stops. Absent when the
     * adapter can't (`capabilities.adoptionViaApi`).
     */
    adopt?(name: string): Promise<AdoptedDomain>;
    /** Drops the domain at the provider. Absent when the adapter has nothing to drop. */
    remove?(name: string, providerDomainId: string | null): Promise<void>;
  };
  /** Provider-side plumbing a domain needs before events arrive. Absent when there's none. */
  setup?: {
    /** Whether this account's plumbing is finished. The domains layer never reads a settings key itself. */
    isConfigured(settings: ProviderSettings): boolean;
    configureEvents(domain: string, context: SetupContext): Promise<ConfiguredEvents>;
    /** Removes what `configureEvents` built. Present only on a tenant, which offboarding tears down. */
    teardown?(): Promise<void>;
  };
  /** Present on a shared account: reads its tenants' sending status. */
  tenants?: {
    /** Tenant status changes carried by a verified callback. */
    parseStatus(request: SignedRequest): TenantStatusEvent[];
    /** The tenant's current sending status, or null when the provider has no such tenant. Throws when the read fails. */
    status(tenantName: string): Promise<TenantSendingStatus | null>;
    /** Open reputation findings across tenants, one paced call per page. Null when the provider didn't answer. */
    findings?(maxPages: number, spacing: () => Promise<void>): Promise<TenantFindings | null>;
    /** A tenant's own send, bounce and complaint counts over `days`. */
    volume?(tenantArn: string, days: number): Promise<MetricRead<TenantVolume>>;
  };
  /** Present on a tenant-capable adapter: turns an ordinary account into a tenant in place. */
  conversion?: TenantConversion;
  events: {
    /** Async because a provider may have to fetch a signing key to check the signature. */
    verify(request: SignedRequest): Promise<boolean>;
    parse(request: SignedRequest): NormalizedEvent[];
    /** Handles a provider's own control message, such as a subscription confirmation. */
    control?(request: SignedRequest): Promise<ControlOutcome>;
  };
  /** Receiving mail for a domain (#6). Absent entirely when the adapter can't receive. */
  inbound?: {
    /**
     * DNS records this adapter needs to receive mail on `host`, the domain's inbound subdomain —
     * never the domain's own apex, so the domain's existing mailbox is untouched. Pure: never
     * calls the provider. `required` is always false here; inbound is opt-in and never gates the
     * domain's own send verification.
     */
    records(host: string): ProposedDnsRecord[];
    /**
     * Verifies one callback to the inbound route. Sync, unlike `events.verify` — nothing here
     * needs a network round trip to check a signature. `settings` is the domain's own
     * `inboundProviderSettings`, not the account's: some providers key inbound verification per
     * domain rather than per account (Mailpace does — each domain has its own webhook keypair).
     * Absent when mail arrives through `received` instead.
     */
    verify?(request: SignedRequest, settings: Record<string, string>): boolean;
    parse?(request: SignedRequest): NormalizedInboundMessage[];
    /**
     * Routes `route.host`'s mail to the service at the provider. Rerunning it converges. Returns
     * what to store as the domain's `inboundProviderSettings`. Absent when routing is a console
     * step. Throws `InboundUnavailableError` when the account can't receive yet.
     */
    open?(route: InboundRoute): Promise<Record<string, string>>;
    /** Undoes `open`. Routing that's already gone succeeds. */
    close?(route: InboundRoute, settings: Record<string, string>): Promise<void>;
    /**
     * Mail announced on the account's event channel, read out of the provider's storage. Called
     * only after `events.verify` passed. Null when the request isn't an inbound announcement.
     */
    received?(request: SignedRequest): Promise<ReceivedMail | null>;
    /** A message still in the provider's storage, by its key, for a replay. Null for a key outside the routing. */
    stored?(key: string): ReceivedMail | null;
  };
  /**
   * Whether `healthCheck` can reach the provider with the credentials this account holds. Per
   * account, not per adapter: Mailpace can only check when an organization token is on file.
   */
  readonly canHealthCheck: boolean;
  /**
   * A real, cheap call that proves this account's credentials and reachability — never a config
   * read. Never throws. Runs on a slow interval (lib/health), so it never fires per-request.
   */
  healthCheck(): Promise<AdapterHealth>;
  /**
   * The provider's own identifier for the account behind these credentials — independent of
   * Pouch's account id and the organization holding it. Absent entirely when the adapter has no
   * such concept to report (Mailpace has no account-level id in its API). Present but resolving
   * to `null` when the adapter has the concept but couldn't answer this call — a transient
   * failure, never grounds to guess. Never throws.
   */
  identity?(): Promise<string | null>;
  /** The account's send quota and enforcement status, or null when the call fails. Never throws. */
  quota?(): Promise<AccountQuota | null>;
  /** The provider's own bounce and complaint rates for the account. Never throws. */
  reputationRates?(): Promise<MetricRead<AccountRates>>;
}

export type ConversionStep = "parent_setup" | "tenant" | "associate" | "tag" | "suppression";

/** Resources an ordinary account already holds, to move under a tenant. */
export interface ConversionResources {
  configurationSetName: string;
  identities: string[];
}

/** Each call tolerates a rerun after it stopped part way. */
/** The parts of a conversion that read no credentials. */
export type ConversionPlanner = Pick<TenantConversion, "permissions" | "calls">;

export interface TenantConversion {
  /** Permissions the given steps need, as IAM actions. */
  permissions(steps: ConversionStep[]): string[];
  /** Which of `actions` the credentials' own principal isn't allowed. A check it isn't allowed to run reports its own permission. */
  missingPermissions(actions: string[]): Promise<string[]>;
  /** The provider calls a step makes, by SDK name, for a dry run. */
  calls(step: ConversionStep | "preflight", tenantName: string, resources: ConversionResources): string[];
  /** Creates the tenant, or finds it, and returns its ARN. */
  ensureTenant(tenantName: string): Promise<string>;
  /** Associates existing resources with the tenant. Refuses an identity another account or tenant holds. */
  associate(tenantName: string, tenantArn: string, resources: ConversionResources): Promise<void>;
  /** Tags each identity as the tenant's. */
  tagIdentities(tenantName: string, tenantArn: string, identities: string[]): Promise<void>;
  /** Copies the account-level suppression list into the tenant's. Returns how many addresses it added. */
  copySuppressions(tenantName: string): Promise<number>;
}

export interface AccountQuota {
  max24HourSend: number | null;
  /** Sends per second. */
  maxSendRate: number | null;
  sentLast24Hours: number | null;
  enforcementStatus: string | null;
}

/** A metric read that can be refused for a missing permission without being an error. */
export type MetricRead<T> = { state: "ok"; value: T } | { state: "denied"; permission: string } | { state: "failed" };

export interface AccountRates {
  /** Null when the provider published no datapoint in the window. */
  bounceRate: number | null;
  complaintRate: number | null;
  at: Date | null;
}

export interface TenantVolume {
  sends: number;
  bounces: number;
  complaints: number;
}

export interface TenantFinding {
  tenantRef: string;
  tenantName: string | null;
  type: string;
  impact: string | null;
  description: string | null;
  openedAt: Date | null;
}

export interface TenantFindings {
  findings: TenantFinding[];
  /** False when pages were left unread, so absence proves nothing. */
  complete: boolean;
}

/** A tenant row's `tenantState` until its first CreateTenant attempt. Read by the core, set by SES. */
export const TENANT_UNREQUESTED = "unrequested";

export type TenantSendingStatus = "enabled" | "disabled";

export interface TenantStatusEvent {
  kind: "sending_enabled" | "sending_disabled" | "finding_opened" | "finding_closed";
  /** The provider's own reference to the tenant. */
  tenantRef: string;
  tenantName: string | null;
  detail: Record<string, unknown>;
}

/** Thrown by `domain.create` when the provider already holds the domain for someone else. */
export class DomainUnavailableError extends Error {
  constructor(domain: string) {
    super(`${domain} is already held by someone else at the provider.`);
    this.name = "DomainUnavailableError";
  }
}

/** Thrown when this account's credentials can't reach the provider's domains API. */
export class DomainApiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainApiUnavailableError";
  }
}

/** Thrown by `domain.adopt` when the provider has no identity to take over. */
export class DomainNotAtProviderError extends Error {
  constructor(domain: string) {
    super(`The provider has no domain ${domain} to adopt.`);
    this.name = "DomainNotAtProviderError";
  }
}

export interface AdapterHealth {
  /** Null when the adapter has no way to probe itself and health can only come from send outcomes. */
  ok: boolean | null;
  /**
   * What's wrong, in a fixed set of categories (credentials rejected, rate limited, unreachable) —
   * never the provider's raw error text. This can reach an unauthenticated endpoint.
   */
  detail: string | null;
  /** Set when the provider throttled the probe, which says nothing about the account. */
  throttled?: boolean;
}

/** Where the provider should post its delivery events. */
export interface WebhookTarget {
  webhookUrl: string;
}

export interface SetupContext extends WebhookTarget {
  /** Stores what's been created so far. An adapter calls this before any step that depends on it. */
  save(settings: Record<string, string>): Promise<void>;
  /** Identities to attach again, when setup rebuilds something they were attached to. */
  identities?: string[];
}

/** What an adapter created on the provider so events reach the service. */
export interface ConfiguredEvents {
  /** Non-secret config to store on the provider. */
  settings: Record<string, string>;
}

/** Non-secret provider config: configuration set names, topic ARNs, webhook public keys. */
export type ProviderSettings = Record<string, string>;

export interface AdapterOptions {
  /** The key the adapter paces its non-send API calls under. */
  apiRateSubject?: string | null;
  /** Merges keys into the account's stored settings. */
  saveSettings?(patch: Record<string, string>): Promise<void>;
}

/** Builds an adapter from a decrypted credentials object and the account's settings. */
export type AdapterFactory = (
  credentials: Record<string, string>,
  settings: ProviderSettings,
  accountId: string,
  options?: AdapterOptions,
) => Adapter;

/**
 * Everything the registry knows about an adapter. Capabilities, the schemas and `isConfigured`
 * sit here rather than on `Adapter` so reading them never decrypts an account's credentials.
 */
export interface AdapterModule {
  /** Adapter key. Matches providers.adapter. */
  adapter: string;
  capabilities: AdapterCapabilities;
  /** What the adapter needs to be configured with. The dashboard and the seed both read this. */
  credentialsSchema: z.ZodObject;
  /** Non-secret config the adapter reads. */
  settingsSchema: z.ZodObject;
  /** Whether the account's own event plumbing is finished. Absent when the adapter has no setup step. */
  isConfigured?(settings: ProviderSettings): boolean;
  /** What converting an account into a tenant would need and call. Absent when the adapter has no tenants. */
  conversionPlan?: ConversionPlanner;
  create: AdapterFactory;
}
