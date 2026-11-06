import {
  ChangeResourceRecordSetsCommand,
  GetHostedZoneCommand,
  ListHostedZonesCommand,
  ListResourceRecordSetsCommand,
  Route53Client,
  type HostedZone,
  type ResourceRecordSet,
  type RRType,
} from "@aws-sdk/client-route-53";
import { z } from "zod";
import { logger } from "@/lib/logger";
import type { DnsRecordType, ObservedDnsRecord, ProposedDnsRecord } from "@/lib/providers/adapters/types";
import {
  DnsNotSupportedError,
  type DnsProvider,
  type DnsProviderCapabilities,
  type DnsProviderFactory,
  type DnsProviderModule,
  type DnsRecordRef,
  type DnsWriteResult,
  type DnsZone,
  type AdapterHealth,
} from "./types";

const log = logger.child("dns-provider:route53");

// Route53 is a single global service, not regional — one endpoint regardless of where the
// zone's traffic is served. No region field here, unlike SES.
const credentialsSchema = z.object({
  accessKeyId: z
    .string()
    .min(1)
    .describe(
      "Access key id for an IAM user or role. Least privilege: route53:ListResourceRecordSets and route53:ChangeResourceRecordSets " +
        "scoped to the target hosted zone's ARN, plus route53:ListHostedZones account-wide for an account-scoped credential that " +
        "should offer a zone picker. A zone-scoped credential (see `hostedZoneId` below) also needs route53:GetHostedZone on that " +
        "same zone — one more action than #213 named, needed so `findZone` can confirm the zone id actually serves the typed domain " +
        "the same way the Cloudflare adapter does for its zone-scoped token.",
    ),
  secretAccessKey: z.string().min(1).describe("Secret access key for that credential."),
});

const settingsSchema = z.object({
  hostedZoneId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Hosted zone id for a zone-scoped credential, whose IAM policy can't call ListHostedZones. The domain is typed, not picked, " +
        "same as Cloudflare's zoneId. Omit for an account-scoped credential, which resolves a domain to its zone by listing.",
    ),
});

// Route53 refuses a real CNAME at the zone apex outright — there's no flattening feature like
// Cloudflare's. An apex alias needs Route53's own ALIAS record type, which isn't a DNS record
// type this port models (`DnsRecordType` is TXT | CNAME | MX), so this module simply can't offer
// it, not "won't". NS records can be changed through the same ChangeResourceRecordSets call this
// module already uses for everything else, though nothing here ever does. Zone enumeration needs
// ListHostedZones, which an account-scoped credential has and a zone-scoped one doesn't.
const capabilities: DnsProviderCapabilities = {
  apexCname: false,
  nsWritable: true,
  zoneEnumeration: true,
};

const DNS_RECORD_TYPES = new Set<DnsRecordType>(["TXT", "CNAME", "MX"]);

// Route53 has no "automatic" TTL the way Cloudflare does — every basic (non-alias) record set
// needs an explicit one. `ProposedDnsRecord` carries no TTL field at all, since Cloudflare never
// needed one, so every write from this module uses the same fixed value. Worth a `ttl?: number`
// on `ProposedDnsRecord` if a caller ever needs to vary it; nothing does today.
const DEFAULT_TTL_SECONDS = 300;

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Strips the trailing dot Route53 always returns, so names compare cleanly. */
function normalizeName(name: string): string {
  return name.replace(/\.$/, "").toLowerCase();
}

/** Route53 hands back hosted zone ids as `/hostedzone/XXXX`; the bare id is the opaque handle this port wants. */
function stripZonePrefix(id: string): string {
  return id.replace(/^\/hostedzone\//, "");
}

function toDnsZone(zone: HostedZone): DnsZone {
  return { name: normalizeName(zone.Name ?? ""), id: stripZonePrefix(zone.Id ?? "") };
}

/**
 * Route53 wraps a TXT value in DNS wire-format quoting: one or more double-quoted
 * <character-string> chunks (each up to 255 bytes), space-separated, that concatenate into one
 * logical value. Cloudflare hands back the unquoted value directly — this undoes Route53's
 * quoting so both adapters agree on what `ObservedDnsRecord.value` means. Falls back to the raw
 * string if Route53 ever returns something unquoted (it shouldn't, for TXT).
 */
function parseTxtValue(raw: string): string {
  const pattern = /"((?:[^"\\]|\\.)*)"/g;
  const chunks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    chunks.push(match[1]!.replace(/\\(.)/g, "$1"));
  }
  return chunks.length > 0 ? chunks.join("") : raw;
}

/**
 * The inverse of `parseTxtValue`: re-wraps a logical value into Route53's quoted, 255-character
 * chunked wire format for a write. Chunks on character count, not byte length — every TXT value
 * this codebase writes (SPF, DKIM public keys) is ASCII, so the two coincide.
 */
function formatTxtValue(value: string): string {
  if (value.length === 0) return '""';
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += 255) {
    const chunk = value.slice(offset, offset + 255).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    chunks.push(`"${chunk}"`);
  }
  return chunks.join(" ");
}

/** Route53's MX rdata is `"<priority> <host>"` in one string — Cloudflare and this port keep those as separate fields. */
function parseMxValue(raw: string): { value: string; priority: number } {
  const [priority, ...rest] = raw.trim().split(/\s+/);
  return { value: rest.join(" "), priority: Number(priority ?? 0) };
}

function formatMxValue(record: ProposedDnsRecord): string {
  return `${record.priority ?? 0} ${record.value}`;
}

/**
 * Splits one Route53 record set into the `ObservedDnsRecord`s it represents.
 *
 * A Route53 `ResourceRecordSet` is keyed by (name, type) and its `ResourceRecords` array can hold
 * more than one value — every MX and TXT record this module reads is potentially multi-valued,
 * where Cloudflare always models one value as one record. Since `ObservedDnsRecord` has no way to
 * express "these N values are one set," each value becomes its own `ObservedDnsRecord` here, the
 * same choice Cloudflare's plain record list makes. The difference shows up in `id`: Route53 has
 * no id for one value within a set, or for the set itself — only (name, type) identify it — so
 * every value from the same set is given the same synthesized id (`type:name`). That's honest
 * about what Route53 can distinguish, but it means `id` can't be trusted to tell two values at
 * the same name apart the way it can for Cloudflare. Nothing in this codebase reads `.id` outside
 * an adapter's own `upsertRecords` today, so this doesn't break a caller — see the PR body for
 * where it would.
 */
function toObservedDnsRecords(rrset: ResourceRecordSet): ObservedDnsRecord[] {
  const type = rrset.Type as DnsRecordType;
  if (!DNS_RECORD_TYPES.has(type)) return [];

  const name = normalizeName(rrset.Name ?? "");
  const id = `${type}:${name}`;

  return (rrset.ResourceRecords ?? []).map((record): ObservedDnsRecord => {
    const raw = record.Value ?? "";
    if (type === "TXT") return { id, type, name, value: parseTxtValue(raw) };
    if (type === "MX") {
      const { value, priority } = parseMxValue(raw);
      return { id, type, name, value, priority };
    }
    return { id, type, name, value: raw };
  });
}

const AUTH_ERROR_NAMES = new Set([
  "AccessDenied",
  "AccessDeniedException",
  "InvalidClientTokenId",
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "UnrecognizedClientException",
]);
const THROTTLE_ERROR_NAMES = new Set(["Throttling", "ThrottlingException", "TooManyRequestsException"]);

function classifyHealthError(err: unknown): AdapterHealth {
  const name = (err as { name?: string } | undefined)?.name;
  if (name && AUTH_ERROR_NAMES.has(name)) return { ok: false, detail: "Credentials were rejected." };
  if (name && THROTTLE_ERROR_NAMES.has(name)) return { ok: false, detail: "Rate limited by the provider." };
  log.warn(`health check threw: ${reasonOf(err)}`);
  return { ok: false, detail: "Provider unreachable or returned an error." };
}

const create: DnsProviderFactory = (credentials, settings): DnsProvider => {
  const { accessKeyId, secretAccessKey } = credentialsSchema.parse(credentials);
  const { hostedZoneId } = settingsSchema.parse(settings);

  const client = new Route53Client({ region: "us-east-1", credentials: { accessKeyId, secretAccessKey } });

  async function listAllZones(): Promise<DnsZone[]> {
    const zones: DnsZone[] = [];
    let marker: string | undefined;
    for (;;) {
      const page = await client.send(new ListHostedZonesCommand({ Marker: marker }));
      for (const zone of page.HostedZones ?? []) zones.push(toDnsZone(zone));
      if (!page.IsTruncated || !page.NextMarker) break;
      marker = page.NextMarker;
    }
    return zones;
  }

  /**
   * Pages through every record set in the zone. `StartRecordName`/`StartRecordType` narrow where
   * the listing begins, but Route53 still returns everything from that point in lexicographic
   * order — there's no server-side "give me exactly this name" filter the way Cloudflare's
   * `?name=` is, so an exact-name lookup still reads and discards whatever else was on the same
   * page.
   */
  async function listAllRecordSets(zoneId: string, startName?: string): Promise<ResourceRecordSet[]> {
    const sets: ResourceRecordSet[] = [];
    let name = startName;
    let type: RRType | undefined;
    for (;;) {
      const page = await client.send(
        new ListResourceRecordSetsCommand({ HostedZoneId: zoneId, StartRecordName: name, StartRecordType: type }),
      );
      sets.push(...(page.ResourceRecordSets ?? []));
      if (!page.IsTruncated) break;
      name = page.NextRecordName;
      type = page.NextRecordType;
    }
    return sets;
  }

  return {
    module: "route53",
    capabilities,

    async listZones(): Promise<DnsZone[]> {
      if (hostedZoneId) {
        throw new DnsNotSupportedError("This is a zone-scoped credential — it can't list zones.");
      }
      return listAllZones();
    },

    async findZone(domain: string): Promise<DnsZone | null> {
      const target = normalizeName(domain);

      if (hostedZoneId) {
        const { HostedZone: zone } = await client.send(new GetHostedZoneCommand({ Id: hostedZoneId }));
        if (!zone) return null;
        return normalizeName(zone.Name ?? "") === target ? toDnsZone(zone) : null;
      }

      const zones = await listAllZones();
      return zones.find((zone) => zone.name === target) ?? null;
    },

    async getRecords(zone: DnsZone, name?: string): Promise<ObservedDnsRecord[]> {
      const target = name ? normalizeName(name) : undefined;
      const sets = await listAllRecordSets(zone.id, target);
      const observed = sets.flatMap(toObservedDnsRecords);
      return target ? observed.filter((record) => record.name === target) : observed;
    },

    /**
     * Writes each record as its own `ChangeResourceRecordSets` UPSERT, one at a time — Route53
     * has no per-record write; UPSERT replaces the entire record set at (name, type) with exactly
     * the values given. That's safe here only because of how this is actually called: `dns-plan`
     * (#210, and #232's multi-value handling) only ever reaches a `create` or `merge` verdict, and
     * hence only ever calls this, when at most one value already lives at that (name, type) — a
     * matching value among several is `already_correct` and never written, and anything else with
     * several values already there is `conflict`. So every write below either creates a set that
     * was empty or replaces a set that held exactly the one value being superseded; it never has
     * a sibling value to lose. That invariant lives in `dns-plan.ts`, not here, so this re-checks
     * it before writing rather than trusting the caller blind — the same posture the Cloudflare
     * and mock adapters already take before their own write. A record set that picked up a second
     * value since the plan was computed (another process, a hand edit) fails this record rather
     * than UPSERT discarding it.
     */
    async upsertRecords(zone: DnsZone, records: ProposedDnsRecord[]): Promise<DnsWriteResult[]> {
      const results: DnsWriteResult[] = [];
      for (const record of records) {
        const name = normalizeName(record.name);
        try {
          const existing = await client.send(
            new ListResourceRecordSetsCommand({
              HostedZoneId: zone.id,
              StartRecordName: name,
              StartRecordType: record.type as RRType,
              MaxItems: 1,
            }),
          );
          const currentSet = existing.ResourceRecordSets?.[0];
          const isThisSet = currentSet && normalizeName(currentSet.Name ?? "") === name && currentSet.Type === record.type;
          const existingCount = isThisSet ? (currentSet.ResourceRecords?.length ?? 0) : 0;
          if (existingCount > 1) {
            throw new Error(`More than one ${record.type} value already exists at ${name}; refusing to replace the set blind.`);
          }

          const value = record.type === "TXT" ? formatTxtValue(record.value) : record.type === "MX" ? formatMxValue(record) : record.value;

          await client.send(
            new ChangeResourceRecordSetsCommand({
              HostedZoneId: zone.id,
              ChangeBatch: {
                Changes: [
                  {
                    Action: "UPSERT",
                    ResourceRecordSet: {
                      Name: name,
                      Type: record.type,
                      TTL: DEFAULT_TTL_SECONDS,
                      ResourceRecords: [{ Value: value }],
                    },
                  },
                ],
              },
            }),
          );
          results.push({ name, type: record.type, status: "applied" });
        } catch (err) {
          results.push({ name, type: record.type, status: "failed", error: reasonOf(err) });
        }
      }
      return results;
    },

    async removeRecords(_zone: DnsZone, _records: DnsRecordRef[]): Promise<void> {
      throw new Error("removeRecords is unimplemented until #211.");
    },

    /**
     * The cheapest read each credential shape can make: `ListResourceRecordSets` on the one zone
     * a zone-scoped credential is granted, `ListHostedZones` for an account-scoped one that can
     * see the whole account. Both are in #213's named least-privilege policy, unlike
     * `GetHostedZone` (see `credentialsSchema` above), so this never needs the extra permission.
     */
    async healthCheck(): Promise<AdapterHealth> {
      try {
        if (hostedZoneId) {
          await client.send(new ListResourceRecordSetsCommand({ HostedZoneId: hostedZoneId, MaxItems: 1 }));
        } else {
          await client.send(new ListHostedZonesCommand({ MaxItems: 1 }));
        }
        return { ok: true, detail: null };
      } catch (err) {
        return classifyHealthError(err);
      }
    },
  };
};

export const route53: DnsProviderModule = {
  module: "route53",
  capabilities,
  credentialsSchema,
  settingsSchema,
  create,
};
