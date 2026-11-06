/** The service's DMARC report host: the operator's setting, its provider route, its records and each domain's address on it. */
import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { ApiError } from "@/lib/api/errors";
import { checkRecords, type DnsRecordCheck } from "@/lib/domains/dns-check";
import { safeErrorMessage } from "@/lib/errors/scrub";
import { logger } from "@/lib/logger";
import { adapterFor } from "@/lib/providers";
import { InboundUnavailableError, type ProposedDnsRecord } from "@/lib/providers/adapters/types";
import { dmarcDomainTokens, dmarcReportHosts, providers, REPORT_HOST_ROW_ID } from "@/lib/db/schema";
import { dmarcOffFor } from "./switch";

const log = logger.child("dmarc:host");

/** The route id the report host is opened under at the provider, in place of a domain id. */
export const REPORT_ROUTE_ID = "dmarc-reports";

/** Authorizes reports about any domain (RFC 7489 §7.1). */
export const REPORT_AUTHORIZATION_VALUE = "v=DMARC1";

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export interface ReportHostSettings {
  host: string | null;
  providerId: string | null;
  route: Record<string, string> | null;
  verifiedAt: Date | null;
}

const NONE: ReportHostSettings = { host: null, providerId: null, route: null, verifiedAt: null };

export async function readReportHostSettings(): Promise<ReportHostSettings> {
  const [row] = await db
    .select({ host: dmarcReportHosts.host, providerId: dmarcReportHosts.providerId, route: dmarcReportHosts.route, verifiedAt: dmarcReportHosts.verifiedAt })
    .from(dmarcReportHosts)
    .where(eq(dmarcReportHosts.id, REPORT_HOST_ROW_ID))
    .limit(1);
  return row ?? NONE;
}

/** The host domains point their `rua` at: set, and its records checked out. Null otherwise. */
export async function activeReportHost(): Promise<string | null> {
  const settings = await readReportHostSettings();
  return settings.host && settings.verifiedAt ? settings.host : null;
}

export function authorizationName(host: string): string {
  return `*._report._dmarc.${host}`;
}

async function write(patch: Partial<ReportHostSettings>): Promise<void> {
  const now = await dbNow();
  await db
    .insert(dmarcReportHosts)
    .values({ id: REPORT_HOST_ROW_ID, ...patch, updatedAt: now })
    .onConflictDoUpdate({ target: dmarcReportHosts.id, set: { ...patch, updatedAt: now } });
}

/** Shared providers that route received mail through their API, the only kind that can take the host. */
export async function reportHostProviders(): Promise<{ id: string; name: string; adapter: string }[]> {
  const rows = await db.select().from(providers).where(and(isNull(providers.organizationId), eq(providers.shared, true)));
  return rows.flatMap((row) => {
    const inbound = adapterFor(row).inbound;
    return inbound?.open && inbound.received ? [{ id: row.id, name: row.name, adapter: row.adapter }] : [];
  });
}

async function loadReceiver(providerId: string) {
  const [provider] = await db.select().from(providers).where(and(eq(providers.id, providerId), isNull(providers.organizationId))).limit(1);
  if (!provider) throw new ApiError("not_found", `No shared provider with id ${providerId}.`);
  const client = adapterFor(provider);
  if (!client.inbound?.open || !client.inbound.received) {
    throw new ApiError("capability_unavailable", `${provider.name} can't route received mail through its API. Pick a provider that can, such as SES.`);
  }
  return { provider, client };
}

/** What the operator publishes: the provider's records for receiving on the host, and the authorization wildcard. */
export async function reportHostRecords(settings?: ReportHostSettings): Promise<ProposedDnsRecord[]> {
  const { host, providerId } = settings ?? (await readReportHostSettings());
  if (!host || !providerId) return [];
  const [provider] = await db.select().from(providers).where(eq(providers.id, providerId)).limit(1);
  const receiving = provider ? (adapterFor(provider).inbound?.records(host) ?? []) : [];
  return [
    ...receiving.map((record) => ({ ...record, required: true })),
    { type: "TXT", name: authorizationName(host), value: REPORT_AUTHORIZATION_VALUE, required: true },
  ];
}

async function closeRoute(settings: ReportHostSettings): Promise<void> {
  if (!settings.host || !settings.providerId) return;
  const [provider] = await db.select().from(providers).where(eq(providers.id, settings.providerId)).limit(1);
  const close = provider ? adapterFor(provider).inbound?.close : undefined;
  if (!close) return;
  await close({ domainId: REPORT_ROUTE_ID, host: settings.host }, settings.route ?? {}).catch((err) =>
    log.warn(`taking down the report route on ${settings.host} failed: ${safeErrorMessage(err)}`),
  );
}

/**
 * Sets the report host and the provider that receives it, opening the route there. A null host
 * clears it and takes the route down; a changed host or provider closes the old route first.
 */
export async function setReportHost(input: { host: string | null; providerId: string | null }): Promise<void> {
  const current = await readReportHostSettings();
  const host = input.host?.trim().toLowerCase().replace(/\.$/, "") || null;

  if (!host) {
    await closeRoute(current);
    await write({ host: null, providerId: null, route: null, verifiedAt: null });
    return;
  }
  if (!HOSTNAME.test(host) || host.length > 200) throw new ApiError("validation_failed", `${host} isn't a host name.`, { field: "host" });
  if (!input.providerId) throw new ApiError("validation_failed", "Pick the provider that receives report mail.", { field: "providerId" });

  const { provider, client } = await loadReceiver(input.providerId);
  const unchanged = current.host === host && current.providerId === provider.id;
  if (!unchanged) await closeRoute(current);

  let route: Record<string, string>;
  try {
    route = await client.inbound!.open!({ domainId: REPORT_ROUTE_ID, host });
  } catch (err) {
    if (err instanceof InboundUnavailableError) throw new ApiError("capability_unavailable", err.message);
    throw new ApiError("provider_unavailable", `${provider.name} couldn't route mail for ${host}: ${safeErrorMessage(err)}`);
  }
  await write({ host, providerId: provider.id, route, verifiedAt: unchanged ? current.verifiedAt : null });
}

export interface ReportHostCheck {
  checks: DnsRecordCheck[];
  verified: boolean;
}

/** Checks the host's records live and stamps or clears `verifiedAt`. A lookup that doesn't answer changes nothing. */
export async function verifyReportHost(): Promise<ReportHostCheck | null> {
  const settings = await readReportHostSettings();
  if (!settings.host) return null;
  const checks = await checkRecords(await reportHostRecords(settings));
  const matched = checks.length > 0 && checks.every((check) => check.verdict === "match");
  const answered = checks.every((check) => check.verdict !== "unresolved");
  if (matched && !settings.verifiedAt) await write({ verifiedAt: await dbNow() });
  else if (!matched && answered && settings.verifiedAt) await write({ verifiedAt: null });
  return { checks, verified: matched || (!answered && settings.verifiedAt !== null) };
}

function newToken(): string {
  return randomBytes(12).toString("hex");
}

/** Each domain's token, minted on first ask. */
export async function domainTokens(domains: { id: string; organizationId: string }[]): Promise<Map<string, string>> {
  if (domains.length === 0) return new Map();
  const ids = domains.map((domain) => domain.id);
  const read = async () =>
    db.select({ domainId: dmarcDomainTokens.domainId, token: dmarcDomainTokens.token }).from(dmarcDomainTokens).where(inArray(dmarcDomainTokens.domainId, ids));
  let rows = await read();
  const missing = domains.filter((domain) => !rows.some((row) => row.domainId === domain.id));
  if (missing.length > 0) {
    await db
      .insert(dmarcDomainTokens)
      .values(missing.map((domain) => ({ domainId: domain.id, organizationId: domain.organizationId, token: newToken() })))
      .onConflictDoNothing();
    rows = await read();
  }
  return new Map(rows.map((row) => [row.domainId, row.token]));
}

/**
 * The `rua` URI each domain's recommended `_dmarc` record carries: its token on the report host.
 * Empty while the host isn't set or verified, and for an organization that turned reports off.
 */
export async function dmarcReportUris(domains: { id: string; organizationId: string }[]): Promise<Map<string, string>> {
  if (domains.length === 0) return new Map();
  const host = await activeReportHost();
  if (!host) return new Map();
  const off = await dmarcOffFor([...new Set(domains.map((domain) => domain.organizationId))]);
  const tokens = await domainTokens(domains.filter((domain) => !off.has(domain.organizationId)));
  return new Map([...tokens].map(([domainId, token]) => [domainId, `mailto:${token}@${host}`]));
}

export async function dmarcReportUri(domain: { id: string; organizationId: string }): Promise<string | null> {
  return (await dmarcReportUris([domain])).get(domain.id) ?? null;
}
