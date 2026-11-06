import { and, arrayOverlaps, count, eq, gt, isNotNull, isNull, lte, not, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages } from "@/lib/db/schema";
import { SENSITIVE_DAY_ALERT, sensitiveNoun } from "@/lib/dashboard/message-facts";
import { formatNumber } from "@/lib/format/number";
import { messagesHref } from "@/lib/messages/link";
import { defineObservation, type Finding } from "./_types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Addresses a collapsed condition names before "and N more". */
export const ADDRESSES_SHOWN = 3;

export interface TargetedAddress {
  address: string;
  count: number;
}

export interface TargetedFinding extends Finding {
  /** Most messages first. */
  addresses: TargetedAddress[];
  /** The withheld reason every message shares, "" for a sender's own sensitive mail. Null when they differ. */
  reason: string | null;
}

/** "password reset links", or "sensitive messages" when the reasons differ or are empty. */
function nounFor(reason: string | null, n: number): string {
  const noun = reason === null ? "sensitive message" : sensitiveNoun(reason);
  return n === 1 ? noun : `${noun}s`;
}

function list(addresses: TargetedAddress[]): string {
  const shown = addresses.slice(0, ADDRESSES_SHOWN).map((row) => `${row.address} (${formatNumber(row.count)})`);
  const rest = addresses.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${formatNumber(rest)} more`;
  if (shown.length === 1) return shown[0]!;
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/** Live, single-recipient sensitive messages per address in the 24 hours up to `now`, muted ones left out. */
export const accountTargeted = defineObservation<"account_targeted", TargetedFinding>({
  key: "account_targeted",
  title: "Targeted account",
  description: `One address gets ${SENSITIVE_DAY_ALERT} or more sensitive messages in 24 hours.`,
  tone: "warning",
  mutableBy: ["tag", "key"],
  example: { addresses: [{ address: "jane@example.com", count: 14 }], reason: "a password reset link", tags: ["password-reset"], keyIds: [] },

  async evaluate({ organizationId, now, mutes }) {
    const address = sql<string>`${messages.recipients}[1]`;
    const rows = await db
      .select({ address, reason: messages.bodyWithheld, apiKeyId: messages.apiKeyId, tags: messages.tags, count: count() })
      .from(messages)
      .where(
        and(
          eq(messages.organizationId, organizationId),
          isNotNull(messages.bodyWithheld),
          gt(messages.createdAt, new Date(now.getTime() - DAY_MS)),
          lte(messages.createdAt, now),
          eq(messages.testMode, false),
          sql`cardinality(${messages.recipients}) = 1`,
          mutes.keyIds.length > 0 ? or(isNull(messages.apiKeyId), notInArray(messages.apiKeyId, mutes.keyIds)) : undefined,
          mutes.tags.length > 0 ? not(arrayOverlaps(messages.tags, mutes.tags)) : undefined,
        ),
      )
      .groupBy(address, messages.bodyWithheld, messages.apiKeyId, messages.tags);

    const byAddress = new Map<string, { count: number; reasons: Set<string>; tags: Set<string>; keyIds: Set<string> }>();
    for (const row of rows) {
      const entry = byAddress.get(row.address) ?? { count: 0, reasons: new Set(), tags: new Set(), keyIds: new Set() };
      entry.count += row.count;
      entry.reasons.add(row.reason ?? "");
      for (const tag of row.tags) entry.tags.add(tag);
      if (row.apiKeyId) entry.keyIds.add(row.apiKeyId);
      byAddress.set(row.address, entry);
    }

    const targeted = [...byAddress].filter(([, entry]) => entry.count >= SENSITIVE_DAY_ALERT);
    if (targeted.length === 0) return [];
    const reasons = new Set(targeted.flatMap(([, entry]) => [...entry.reasons]));
    return [
      {
        addresses: targeted
          .map(([address, entry]) => ({ address, count: entry.count }))
          .sort((a, b) => b.count - a.count || a.address.localeCompare(b.address)),
        reason: reasons.size === 1 ? [...reasons][0]! : null,
        tags: [...new Set(targeted.flatMap(([, entry]) => [...entry.tags]))].sort(),
        keyIds: [...new Set(targeted.flatMap(([, entry]) => [...entry.keyIds]))].sort(),
      },
    ];
  },

  condition({ addresses, reason }) {
    const [only] = addresses;
    if (addresses.length === 1 && only) {
      return {
        title: `${only.address} got ${formatNumber(only.count)} ${nounFor(reason, only.count)} in 24 hours`,
        body: `${SENSITIVE_DAY_ALERT} or more in a day is unusual for one address. Someone may be targeting this account.`,
        links: [{ href: messagesHref({ address: only.address, sensitive: true, days: 1 }), label: "See these messages" }],
      };
    }
    return {
      title: `${formatNumber(addresses.length)} addresses got ${SENSITIVE_DAY_ALERT} or more ${nounFor(reason, 2)} in 24 hours`,
      body: `${list(addresses)}. Someone may be targeting these accounts.`,
      links: [{ href: messagesHref({ sensitive: true, days: 1 }), label: "See sensitive messages" }],
    };
  },

  // Owners' mail sits in Admin's service mail log, so it counts addresses and never names one.
  notice({ addresses, reason }) {
    const [only] = addresses;
    const links = [{ href: messagesHref({ sensitive: true, days: 1 }), label: "See sensitive messages" }];
    const wording =
      addresses.length === 1 && only
        ? {
            title: `An address got ${formatNumber(only.count)} ${nounFor(reason, only.count)} in 24 hours`,
            body: `${SENSITIVE_DAY_ALERT} or more in a day is unusual for one address. Someone may be targeting the account.`,
            links,
          }
        : {
            title: `${formatNumber(addresses.length)} addresses got ${SENSITIVE_DAY_ALERT} or more ${nounFor(reason, 2)} in 24 hours`,
            body: `${SENSITIVE_DAY_ALERT} or more in a day is unusual for one address. Someone may be targeting these accounts.`,
            links,
          };
    // One subject per organization.
    return { about: ["organization"], wording };
  },

  // The digest goes to the operator, so it counts addresses and never names one.
  digestLine({ addresses, reason }) {
    const [only] = addresses;
    const path = messagesHref({ sensitive: true, days: 1 });
    if (addresses.length === 1 && only) {
      return {
        text: `one address got ${formatNumber(only.count)} ${nounFor(reason, only.count)} in 24 hours. Someone may be targeting that account.`,
        path,
      };
    }
    return {
      text: `${formatNumber(addresses.length)} addresses each got ${SENSITIVE_DAY_ALERT} or more ${nounFor(reason, 2)} in 24 hours. Someone may be targeting those accounts.`,
      path,
    };
  },
});
