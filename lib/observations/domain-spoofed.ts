import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains } from "@/lib/db/schema";
import { readOriginCounts, SPOOFED_MIN_MESSAGES } from "@/lib/dmarc/read";
import { dmarcOnFor } from "@/lib/dmarc/switch";
import { formatNumber } from "@/lib/format/number";
import { DMARC_SIGNAL_DAYS } from "@/lib/reputation/standing";
import { defineObservation, type Finding } from "./_types";

export { SPOOFED_MIN_MESSAGES };

export interface SpoofedDomain {
  id: string;
  name: string;
  messages: number;
  sources: number;
}

export interface SpoofedFinding extends Finding {
  /** Most messages first. */
  domains: SpoofedDomain[];
}

function plural(count: number, one: string, many: string): string {
  return `${formatNumber(count)} ${count === 1 ? one : many}`;
}

function reputationHref(domain: SpoofedDomain): string {
  return `/domains/${encodeURIComponent(domain.id)}/reputation`;
}

function wording({ domains: found }: SpoofedFinding) {
  const [only] = found;
  if (found.length === 1 && only) {
    return {
      title: `Someone else may be sending as ${only.name}`,
      body: `Mailbox providers reported ${plural(only.messages, "message", "messages")} from ${plural(only.sources, "source", "sources")} that failed DMARC and aren't the domain's provider, over ${DMARC_SIGNAL_DAYS} days.`,
      links: [{ href: reputationHref(only), label: "See the sources" }],
    };
  }
  return {
    title: `Someone else may be sending as ${formatNumber(found.length)} of your domains`,
    body: `${found.map((domain) => `${domain.name} (${formatNumber(domain.messages)})`).join(", ")}: messages that failed DMARC from sources that aren't the domain's provider, over ${DMARC_SIGNAL_DAYS} days.`,
    links: found.slice(0, 3).map((domain) => ({ href: reputationHref(domain), label: `See ${domain.name}` })),
  };
}

/** Mail failing DMARC from sources that aren't the domain's provider or anyone it authorizes, in DMARC reports. */
export const domainSpoofed = defineObservation<"domain_spoofed", SpoofedFinding>({
  key: "domain_spoofed",
  title: "Sending as your domain",
  description: `Someone other than this domain's provider and its authorized senders sends ${SPOOFED_MIN_MESSAGES} or more messages as it in ${DMARC_SIGNAL_DAYS} days of DMARC reports.`,
  tone: "warning",
  mutableBy: [],
  example: { domains: [{ id: "dom_example", name: "example.com", messages: 42, sources: 3 }], tags: [], keyIds: [] },

  async evaluate({ organizationId, now }) {
    if (!(await dmarcOnFor(organizationId))) return [];
    const counts = await readOriginCounts(organizationId, now);
    const flagged = [...counts].flatMap(([domainId, origins]) => {
      const unauthenticated = origins.unauthenticated;
      return unauthenticated && unauthenticated.messages >= SPOOFED_MIN_MESSAGES ? [{ domainId, ...unauthenticated }] : [];
    });
    if (flagged.length === 0) return [];

    const names = await db.select({ id: domains.id, name: domains.name }).from(domains).where(inArray(domains.id, flagged.map((row) => row.domainId)));
    const found = flagged
      .flatMap((row) => {
        const name = names.find((one) => one.id === row.domainId)?.name;
        return name ? [{ id: row.domainId, name, messages: row.messages, sources: row.sources }] : [];
      })
      .sort((a, b) => b.messages - a.messages || a.name.localeCompare(b.name));
    return found.length > 0 ? [{ domains: found, tags: [], keyIds: [] }] : [];
  },

  condition: wording,

  notice(finding) {
    return { about: finding.domains.map((domain) => `domain:${domain.id}`), wording: wording(finding) };
  },

  digestLine({ domains: found }) {
    const messages = found.reduce((sum, domain) => sum + domain.messages, 0);
    return {
      text: `someone else may be sending as ${found.length === 1 ? found[0]!.name : `${formatNumber(found.length)} domains`}: ${plural(messages, "message", "messages")} failed DMARC from sources that aren't the provider, over ${DMARC_SIGNAL_DAYS} days.`,
      path: reputationHref(found[0]!),
    };
  },
});
