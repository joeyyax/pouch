import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db, type Executor } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { addresses, apiKeys, organizations, webhookDeliveries, webhookEndpoints } from "@/lib/db/schema";
import type { AddressRow, InboundMessageRow } from "@/lib/db/schema";
import { keyCanAccessDomain } from "@/lib/api/keys";
import { isFeatureEnabled } from "@/lib/features";
import { newId } from "@/lib/ids";
import { inboundHost } from "@/lib/inbound/records";
import type { InboundBody } from "@/lib/inbound/attachments";
import { serializeInboundMessage } from "@/lib/inbound/serialize";
import type { InboundVerdicts } from "@/lib/providers/adapters/types";
import { DELIVERY_EXPIRY_MS } from "@/lib/webhooks/backoff";
import { serializeAddress, type AddressDomain } from "./serialize";
import { effectiveAddressLimits, readAddressLimitDefaults } from "./limits";

interface RoutedDomain extends AddressDomain {
  id: string;
  organizationId: string;
}

/** Which of a message's recipients belong to addresses. */
export interface AddressClaim {
  /** True when a recipient on the inbound host isn't an address, so the domain's own webhook hears about it. */
  unclaimed: boolean;
  addresses: AddressRow[];
}

/**
 * Splits recipients on the domain's inbound host into addresses and everything else. A message
 * naming nobody on the host goes to the domain's webhook, as it did before addresses. With the
 * addresses feature off, no address takes mail.
 */
export async function claimRecipients(domain: RoutedDomain, recipients: string[]): Promise<AddressClaim> {
  const suffix = `@${inboundHost(domain.name, domain.inboundSubdomain).toLowerCase()}`;
  const localParts = [
    ...new Set(
      recipients
        .map((recipient) => (/<([^<>]+)>/.exec(recipient)?.[1] ?? recipient).trim().toLowerCase())
        .filter((recipient) => recipient.endsWith(suffix))
        .map((recipient) => recipient.slice(0, -suffix.length)),
    ),
  ];
  if (localParts.length === 0) return { unclaimed: true, addresses: [] };

  const rows = await db
    .select()
    .from(addresses)
    .where(and(eq(addresses.domainId, domain.id), inArray(addresses.localPart, localParts)));
  const on = await isFeatureEnabled("addresses");
  return { unclaimed: rows.length < localParts.length, addresses: on ? rows : [] };
}

function live(row: AddressRow, now: Date): boolean {
  return row.status !== "revoked" && row.expiresAt.getTime() > now.getTime();
}

/** Whether any claimed address could take the message, before anything is locked. */
export function mayDeliver(claim: AddressClaim, verdicts: InboundVerdicts | null, now: Date): boolean {
  if (verdicts?.virus === "fail") return false;
  return claim.addresses.some((row) => live(row, now));
}

/** The UTC calendar day, as Postgres `date` reads it. */
function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Locks each claimed address, counts the message as delivered or dropped on it, and returns the
 * ones it was delivered to. A drop is never refused or bounced: the provider already accepted the
 * mail, and a bounce now is backscatter to a sender who may be forged.
 */
export async function admitToAddresses(tx: Executor, claim: AddressClaim, verdicts: InboundVerdicts | null): Promise<AddressRow[]> {
  if (claim.addresses.length === 0) return [];
  const now = await dbNow(tx);
  const today = utcDay(now);
  const organizationId = claim.addresses[0]!.organizationId;
  const [org] = await tx
    .select({ addressLimit: organizations.addressLimit, addressDailyMessageLimit: organizations.addressDailyMessageLimit })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  const dailyLimit = org ? effectiveAddressLimits(org, await readAddressLimitDefaults()).daily : 0;

  const locked = await tx
    .select()
    .from(addresses)
    .where(inArray(addresses.id, claim.addresses.map((row) => row.id)))
    .orderBy(asc(addresses.id))
    .for("update");

  const delivered: AddressRow[] = [];
  for (const row of locked) {
    let counted: Partial<typeof addresses.$inferInsert>;
    if (!live(row, now)) {
      counted = { droppedExpiredCount: row.droppedExpiredCount + 1 };
    } else if (verdicts?.virus === "fail") {
      counted = { droppedVirusCount: row.droppedVirusCount + 1 };
    } else {
      const todaySoFar = row.receivedDay === today ? row.receivedToday : 0;
      const overCap = row.messageCap !== null && row.receivedCount >= row.messageCap;
      counted =
        overCap || todaySoFar >= dailyLimit
          ? { droppedOverLimitCount: row.droppedOverLimitCount + 1 }
          : { receivedCount: row.receivedCount + 1, receivedToday: todaySoFar + 1, receivedDay: today, lastReceivedAt: now };
    }
    const [updated] = await tx.update(addresses).set(counted).where(eq(addresses.id, row.id)).returning();
    if ("receivedCount" in counted) delivered.push(updated!);
  }
  return delivered;
}

/** `spam` and `dmarc` when the provider failed the message on them. Flagged mail still delivers. */
export function flagsFor(verdicts: InboundVerdicts | null): string[] {
  const flags: string[] = [];
  if (verdicts?.spam === "fail") flags.push("spam");
  if (verdicts?.dmarc === "fail") flags.push("dmarc");
  return flags;
}

/**
 * Enqueues `address.received` for each delivered address on its creating key's endpoints,
 * inside the transaction that stored the message: the same rows, signing and retries as every
 * other event.
 */
export async function enqueueAddressDeliveries(
  tx: Executor,
  domain: RoutedDomain,
  message: InboundMessageRow,
  body: InboundBody,
  delivered: AddressRow[],
): Promise<number> {
  const keyIds = [...new Set(delivered.map((row) => row.apiKeyId).filter((id): id is string => id !== null))];
  if (keyIds.length === 0) return 0;

  const endpoints = await tx
    .select({ endpoint: webhookEndpoints, domainIds: apiKeys.domainIds })
    .from(webhookEndpoints)
    .innerJoin(apiKeys, eq(apiKeys.id, webhookEndpoints.apiKeyId))
    .where(
      and(
        eq(webhookEndpoints.organizationId, domain.organizationId),
        inArray(webhookEndpoints.apiKeyId, keyIds),
        isNull(webhookEndpoints.disabledAt),
        isNull(apiKeys.revokedAt),
      ),
    );

  const now = await dbNow(tx);
  const flags = flagsFor(message.verdicts);
  const rows = delivered.flatMap((address) =>
    endpoints
      .filter(({ endpoint, domainIds }) => endpoint.apiKeyId === address.apiKeyId && endpoint.events.includes("address.received") && keyCanAccessDomain({ domainIds }, domain.id))
      .map(({ endpoint }) => ({
        id: newId("webhookDelivery"),
        organizationId: domain.organizationId,
        endpointId: endpoint.id,
        messageId: null,
        eventType: "address.received" as const,
        payload: {
          id: newId("event"),
          type: "address.received",
          created_at: message.receivedAt.toISOString(),
          data: { ...serializeInboundMessage(message, body), address: serializeAddress(address, domain, now), flags },
        },
        status: "pending" as const,
        attempts: 0,
        nextAttemptAt: now,
        expiresAt: new Date(now.getTime() + DELIVERY_EXPIRY_MS),
      })),
  );
  if (rows.length > 0) await tx.insert(webhookDeliveries).values(rows);
  return rows.length;
}
