/** What the addresses screens derive from an address as the API returns it. */
import type { StatusDotTone } from "@/components/ui/status-dot";
import type { SerializedAddress } from "@/lib/addresses/serialize";
import type { AddressStatus, ForwardTargetStatus } from "@/lib/addresses/constants";
import type { InboundVerdicts } from "@/lib/providers/adapters/types";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const ADDRESS_STATUS_LABEL: Record<AddressStatus, string> = { active: "Active", expired: "Expired", revoked: "Revoked" };
export const ADDRESS_STATUS_ORDER: AddressStatus[] = ["active", "expired", "revoked"];

export const FORWARD_STATUS_LABEL: Record<ForwardTargetStatus, string> = { pending: "Pending", confirmed: "Confirmed", disabled: "Disabled" };
export const FORWARD_STATUS_TONE: Record<ForwardTargetStatus, StatusDotTone> = { pending: "neutral", confirmed: "good", disabled: "warn" };

export const DISABLED_REASON: Record<string, string> = {
  bounced: "A forward hard-bounced.",
  complained: "The mailbox marked a forward as spam.",
  stopped: "The mailbox used the stop link.",
};

/** Under an hour left reads as a warning. */
export const EXPIRING_SOON_SECONDS = HOUR;

/** Past this share of a cap, the count reads as a warning. */
const NEAR_CAP = 0.9;

/** Presets offered to extend, as seconds from now. */
export const EXTEND_OPTIONS = [
  { label: "1 hour", seconds: HOUR },
  { label: "1 day", seconds: DAY },
  { label: "7 days", seconds: 7 * DAY },
  { label: "30 days", seconds: 30 * DAY },
  { label: "90 days", seconds: 90 * DAY },
] as const;

/** The create form's preselected expiry. The API takes no default, so the form picks one. */
export const CREATE_EXPIRY_DEFAULT = DAY;

/** A key the create form offers. A test key shows, disabled: only a live key manages addresses. */
export interface AddressKeyOption {
  id: string;
  name: string;
  mode: "live" | "test";
  /** Empty means every domain. */
  domainIds: string[];
}

/** A domain with inbound on, where an address can live. */
export interface AddressDomainOption {
  id: string;
  name: string;
  host: string;
}

export interface AddressCreateOptions {
  keys: AddressKeyOption[];
  domains: AddressDomainOption[];
}

/** The inbound domains a key reaches. */
export function domainsForKey(key: AddressKeyOption | undefined, domains: AddressDomainOption[]): AddressDomainOption[] {
  if (!key) return [];
  return key.domainIds.length === 0 ? domains : domains.filter((domain) => key.domainIds.includes(domain.id));
}

/** `in 3 days`, `in 5 hours`, `2 days ago`: the largest whole unit, either side of now. */
export function countdownLabel(at: Date, now: Date = new Date()): string {
  const delta = Math.round((at.getTime() - now.getTime()) / 1000);
  const span = Math.abs(delta);
  const [size, name] = span >= DAY ? [DAY, "day"] : span >= HOUR ? [HOUR, "hour"] : span >= MINUTE ? [MINUTE, "minute"] : [1, "second"];
  const count = Math.max(1, Math.floor(span / size));
  const unit = `${count} ${name}${count === 1 ? "" : "s"}`;
  return delta > 0 ? `in ${unit}` : `${unit} ago`;
}

export function expiringSoon(address: Pick<SerializedAddress, "status" | "expires_at">, now: Date = new Date()): boolean {
  const left = (new Date(address.expires_at).getTime() - now.getTime()) / 1000;
  return address.status === "active" && left > 0 && left <= EXPIRING_SOON_SECONDS;
}

/** `issue` at the cap, where mail drops; `warn` close to it; `neutral` otherwise. */
export function capTone(received: number, cap: number | null): StatusDotTone {
  if (cap === null) return "neutral";
  if (received >= cap) return "issue";
  return received >= cap * NEAR_CAP ? "warn" : "neutral";
}

export function droppedTotal(counts: SerializedAddress["counts"]): number {
  return counts.dropped_expired + counts.dropped_over_limit + counts.dropped_virus;
}

/** Drop reasons with a count, in a fixed order. */
export function dropReasons(counts: SerializedAddress["counts"]): { reason: string; count: number }[] {
  return [
    { reason: "after expiry or revocation", count: counts.dropped_expired },
    { reason: "over the cap or daily limit", count: counts.dropped_over_limit },
    { reason: "for a virus", count: counts.dropped_virus },
  ];
}

/** `spam` and `dmarc` when the provider failed the message on them, as the address's webhook flags it. */
export function messageFlags(verdicts: InboundVerdicts | null): string[] {
  const flags: string[] = [];
  if (verdicts?.spam?.toLowerCase() === "fail") flags.push("Spam");
  if (verdicts?.dmarc?.toLowerCase() === "fail") flags.push("DMARC failed");
  return flags;
}
