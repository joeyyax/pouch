import type { SerializedMessageStall } from "@/lib/messages/serialize";

const CAUSE: Record<Exclude<SerializedMessageStall["reason"], "provider_paused">, string> = {
  bounce_rate: "its bounce rate",
  bounce_trend: "its rising bounce rate",
  bounce_count: "its bounces",
  complaint_rate: "its complaint rate",
  complaint_trend: "its rising complaint rate",
  complaint_count: "its complaints",
};

/** Why a queued message is held, as one sentence. */
export function heldSentence(stall: SerializedMessageStall, domainName: string): string {
  if (stall.reason === "provider_paused") return "Held while the email provider has paused sending for this organization.";
  const cause = CAUSE[stall.reason];
  return stall.kind === "domain"
    ? `Held while sending from ${domainName} is paused for ${cause}.`
    : `Held while this organization is suspended on ${cause}.`;
}

/** Where the hold's cause is explained. */
export function heldLink(stall: SerializedMessageStall, domainId: string, domainName: string): { href: string; label: string } {
  return stall.kind === "domain"
    ? { href: `/domains/${domainId}/reputation`, label: `See reputation for ${domainName}` }
    : { href: "/", label: "See the overview" };
}
