import { z } from "zod";
import { logger } from "@/lib/logger";
import type { DnsRecordType, ObservedDnsRecord, ProposedDnsRecord } from "@/lib/providers/adapters/types";
import { fetchWithTimeout } from "@/lib/fetch-timeout";
import { txtText } from "./txt";
import {
  DnsNotSupportedError,
  type DnsProvider,
  type DnsProviderCapabilities,
  type DnsProviderFactory,
  type DnsProviderModule,
  type DnsRecordRef,
  type DnsWriteResult,
  type DnsZone,
} from "./types";

const log = logger.child("dns-provider:cloudflare");

const API_BASE = "https://api.cloudflare.com/client/v4";

// A Global API Key is a 37-character hex string, issued alongside an account email and sent as
// X-Auth-Key rather than a Bearer token. Cloudflare's own newer endpoints already refuse it, but
// the refusal belongs here too, at parse time, not as a confusing 9109 error from the API.
const GLOBAL_API_KEY_PATTERN = /^[0-9a-f]{37}$/i;

const credentialsSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .describe("Cloudflare API token (Bearer), scoped to at least Zone:DNS:Edit on the target zone. Never a Global API Key."),
    /**
     * Present for a zone-scoped token, which can't list zones — the domain is typed, not
     * picked, and this is the only way `findZone` can resolve it. Absent for an account-scoped
     * token, which resolves the same call through `GET /zones?name=`.
     */
    zoneId: z.string().min(1).optional().describe("Zone id for a zone-scoped token. Omit for an account-scoped token."),
  })
  .refine((value) => !GLOBAL_API_KEY_PATTERN.test(value.token), {
    message: "This looks like a Cloudflare Global API Key, not an API token. Create a scoped API token instead.",
    path: ["token"],
  });

const settingsSchema = z.looseObject({});

// Cloudflare can flatten a CNAME at the apex. NS records are never touched by this module,
// though the API could. Zone enumeration is a property of an account-scoped token, checked at
// the credential level (`zoneId` unset) rather than here.
const capabilities: DnsProviderCapabilities = {
  apexCname: true,
  nsWritable: false,
  zoneEnumeration: true,
};

const DNS_RECORD_TYPES = new Set<DnsRecordType>(["TXT", "CNAME", "MX"]);

interface CloudflareError {
  code: number;
  message: string;
}

interface CloudflareEnvelope<T> {
  success: boolean;
  errors: CloudflareError[];
  result: T;
  result_info?: { page: number; per_page: number; total_pages: number; total_count: number };
}

export class CloudflareApiError extends Error {
  readonly status: number;
  readonly errors: CloudflareError[];

  constructor(message: string, status: number, errors: CloudflareError[]) {
    super(message);
    this.name = "CloudflareApiError";
    this.status = status;
    this.errors = errors;
  }
}

interface CloudflareZoneResult {
  id: string;
  name: string;
  status: string;
}

interface CloudflareDnsRecordResult {
  id: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Strips the trailing dot Cloudflare sometimes returns, so names compare cleanly. */
function normalizeName(name: string): string {
  return name.replace(/\.$/, "").toLowerCase();
}

// Matches the sending module's deadline: same API, same worker, reached from domain verification.
const API_TIMEOUT_MS = 30_000;

const create: DnsProviderFactory = (credentials): DnsProvider => {
  const { token, zoneId } = credentialsSchema.parse(credentials);

  async function request<T>(path: string, params?: Record<string, string>): Promise<CloudflareEnvelope<T>> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);

    return readEnvelope<T>(
      await fetchWithTimeout(
        url.toString(),
        { method: "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } },
        API_TIMEOUT_MS,
        `Cloudflare DNS ${path}`,
      ),
    );
  }

  /** POST or PATCH one record. The only place this module writes. */
  async function write<T>(method: "POST" | "PATCH", path: string, body: Record<string, unknown>): Promise<CloudflareEnvelope<T>> {
    return readEnvelope<T>(
      await fetchWithTimeout(
        `${API_BASE}${path}`,
        {
          method,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        API_TIMEOUT_MS,
        `Cloudflare DNS ${path}`,
      ),
    );
  }

  /** DELETE one record. The only place this module removes anything. */
  async function remove<T>(path: string): Promise<CloudflareEnvelope<T>> {
    return readEnvelope<T>(
      await fetchWithTimeout(
        `${API_BASE}${path}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } },
        API_TIMEOUT_MS,
        `Cloudflare DNS ${path}`,
      ),
    );
  }

  async function readEnvelope<T>({ response, text }: { response: Response; text: string }): Promise<CloudflareEnvelope<T>> {
    let body: CloudflareEnvelope<T>;
    try {
      body = JSON.parse(text) as CloudflareEnvelope<T>;
    } catch {
      throw new CloudflareApiError(`Cloudflare returned a non-JSON response (${response.status}).`, response.status, []);
    }

    if (!response.ok || !body.success) {
      const detail = body.errors?.map((error) => error.message).join("; ") || `HTTP ${response.status}`;
      throw new CloudflareApiError(detail, response.status, body.errors ?? []);
    }
    return body;
  }

  /** Pages through every result on a Cloudflare list endpoint. Read-only, so nothing here writes. */
  async function paginate<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
    const results: T[] = [];
    let page = 1;
    for (;;) {
      const envelope = await request<T[]>(path, { ...params, page: String(page), per_page: "50" });
      results.push(...envelope.result);
      const info = envelope.result_info;
      if (!info || page >= info.total_pages) break;
      page += 1;
    }
    return results;
  }

  function toDnsZone(zone: CloudflareZoneResult): DnsZone {
    return { name: normalizeName(zone.name), id: zone.id };
  }

  function toDnsRecord(record: CloudflareDnsRecordResult): ObservedDnsRecord | null {
    if (!DNS_RECORD_TYPES.has(record.type as DnsRecordType)) return null;
    return {
      id: record.id,
      type: record.type as DnsRecordType,
      name: normalizeName(record.name),
      value: record.type === "TXT" ? txtText(record.content) : record.content,
      priority: record.type === "MX" ? record.priority : undefined,
    };
  }

  return {
    module: "cloudflare",
    capabilities,

    async listZones(): Promise<DnsZone[]> {
      if (zoneId) {
        throw new DnsNotSupportedError("This is a zone-scoped credential — it can't list zones.");
      }
      const zones = await paginate<CloudflareZoneResult>("/zones");
      return zones.map(toDnsZone);
    },

    async findZone(domain: string): Promise<DnsZone | null> {
      const target = normalizeName(domain);

      if (zoneId) {
        const envelope = await request<CloudflareZoneResult>(`/zones/${zoneId}`);
        return normalizeName(envelope.result.name) === target ? toDnsZone(envelope.result) : null;
      }

      const zones = await paginate<CloudflareZoneResult>("/zones", { name: target });
      const zone = zones.find((candidate) => normalizeName(candidate.name) === target);
      return zone ? toDnsZone(zone) : null;
    },

    async getRecords(zone: DnsZone, name?: string): Promise<ObservedDnsRecord[]> {
      const params: Record<string, string> = name ? { name: normalizeName(name) } : {};
      const records = await paginate<CloudflareDnsRecordResult>(`/zones/${zone.id}/dns_records`, params);
      return records.map(toDnsRecord).filter((record): record is ObservedDnsRecord => record !== null);
    },

    /**
     * Writes each record one at a time, in order — a single failure never stops the rest, since
     * `applyDnsPlan` (#210) treats every write as its own additive step. A record's final value
     * is looked up by (type, name) rather than a provider id passed in: the caller already
     * merges an SPF value before calling this, so what arrives here is always the complete,
     * final content to publish at that name.
     *
     * Every write is DNS-only (`proxied: false`) — this module only ever writes TXT, CNAME and
     * MX, none of which are meant to route through Cloudflare's proxy, and a DKIM CNAME left
     * proxied is the most common Cloudflare-plus-email failure (#84).
     */
    async upsertRecords(zone: DnsZone, records: ProposedDnsRecord[]): Promise<DnsWriteResult[]> {
      const results: DnsWriteResult[] = [];
      for (const record of records) {
        const name = normalizeName(record.name);
        try {
          const existing = (await paginate<CloudflareDnsRecordResult>(`/zones/${zone.id}/dns_records`, { name, type: record.type }))
            .map(toDnsRecord)
            .filter((candidate): candidate is ObservedDnsRecord => candidate !== null);

          if (existing.length > 1) {
            throw new Error(`More than one ${record.type} record already exists at ${name}; refusing to guess which to update.`);
          }

          const payload: Record<string, unknown> = { type: record.type, name, content: record.value, proxied: false };
          if (record.type === "MX") payload.priority = record.priority ?? 0;

          if (existing[0]) {
            await write("PATCH", `/zones/${zone.id}/dns_records/${existing[0].id}`, payload);
          } else {
            await write("POST", `/zones/${zone.id}/dns_records`, payload);
          }
          results.push({ name, type: record.type, status: "applied" });
        } catch (err) {
          results.push({ name, type: record.type, status: "failed", error: reasonOf(err) });
        }
      }
      return results;
    },

    /**
     * Deletes each record by (type, name) — never a value passed in, since `dns-cleanup.ts`
     * (#211) has already re-read this exact record's live value before calling here. Ambiguous
     * or already-gone is a no-op rather than a guess: `dns-cleanup.ts`'s own plan is what decides
     * whether a record is safe to remove, this only carries out a decision already made.
     */
    async removeRecords(zone: DnsZone, records: DnsRecordRef[]): Promise<void> {
      for (const record of records) {
        const name = normalizeName(record.name);
        const existing = (await paginate<CloudflareDnsRecordResult>(`/zones/${zone.id}/dns_records`, { name, type: record.type }))
          .map(toDnsRecord)
          .filter((candidate): candidate is ObservedDnsRecord => candidate !== null);

        if (existing.length === 0) continue;
        if (existing.length > 1) {
          throw new Error(`More than one ${record.type} record exists at ${name}; refusing to guess which to delete.`);
        }

        await remove(`/zones/${zone.id}/dns_records/${existing[0]!.id}`);
      }
    },

    /**
     * `/user/tokens/verify` is a dedicated, cheap check every Cloudflare API token can call
     * regardless of its zone or account scope — it proves the token without touching a zone.
     */
    async healthCheck() {
      try {
        await request<{ id: string; status: string }>("/user/tokens/verify");
        return { ok: true, detail: null };
      } catch (err) {
        if (err instanceof CloudflareApiError) {
          if (err.status === 401 || err.status === 403) return { ok: false, detail: "Credentials were rejected." };
          if (err.status === 429) return { ok: false, detail: "Rate limited by the provider." };
          return { ok: false, detail: "Provider unreachable or returned an error." };
        }
        log.warn(`health check threw: ${reasonOf(err)}`);
        return { ok: false, detail: "Provider unreachable or returned an error." };
      }
    },
  };
};

export const cloudflare: DnsProviderModule = {
  module: "cloudflare",
  capabilities,
  credentialsSchema: credentialsSchema as z.ZodObject,
  settingsSchema,
  create,
};
