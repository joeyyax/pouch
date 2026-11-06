/**
 * Activity log — taxonomy.
 *
 * The complete set of actions Pouch logs, `domain.subject.verb` (Reeve's convention): the
 * entity comes first, the verb last, and the type of the thing acted on is implied by the
 * prefix, so `applies_to` needs no matching type column. Every action's family and outcome
 * are looked up here and written to the row at insert time (see record.ts) — never derived
 * on read, or every filter scans the table.
 *
 * A new verb is a new entry in this map, not a schema change. Each entry declares which window its
 * rows are kept for and whether they may store the client's hashed address and user agent.
 *
 * Deliberately excluded: per-message lifecycle (queued, sent, delivered, bounced, ...). That's
 * `message_events` (#66) — it answers "what happened to this email", this answers "who changed
 * our setup". Logging delivery events here would bury the provider changes this log exists for
 * under the highest-volume thing the service does.
 *
 * Coverage rule (#120): a route records when it changes provider configuration that outlives the
 * request — domains, suppressions, providers. A route that only reads, or that does the
 * service's ordinary work of accepting a message, doesn't. This has to hold for every caller —
 * dashboard session and API key alike — so the call belongs in the business logic the route
 * calls into, not in the route handler itself; see lib/providers/index.ts and lib/domains/index.ts.
 */
import type { ActivityFamily, ActivityOutcome } from "@/lib/db/schema/activity";
import { formatNumber } from "@/lib/format/number";
import { windowDays, type RetentionClass, type RetentionWindows } from "./windows";

interface ActionDef {
  family: ActivityFamily;
  outcome: ActivityOutcome;
  /** Reads as "<actor> <phrase> <subject>". */
  phrase: string;
  /** True when the sentence is complete without naming a subject — an organization-wide action. */
  standalone?: boolean;
  /** Replaces `phrase` for a run over more than one subject: "removed suppressions on". */
  plural?: string;
  /** The whole sentence for a run whose subjects all went unnamed, `{n}` their count: "removed {n} suppressions". */
  counted?: string;
  /** Which operator-set window a row is kept for. Null keeps it indefinitely. */
  retention: RetentionClass | null;
  /** Whether a keyed hash of the client address and the user agent may be stored with the row. Absent means neither. */
  client?: { ipHash: boolean; userAgent: boolean };
}

const SIGN_IN_CLIENT = { ipHash: true, userAgent: true } as const;

export const ACTIVITY_ACTIONS = {
  "key.created": { family: "key", outcome: "success", phrase: "created key", retention: "setup" },
  "key.revoked": { family: "key", outcome: "success", phrase: "revoked key", retention: "setup" },
  "key.rescoped": { family: "key", outcome: "success", phrase: "changed the domains for key", retention: "setup" },
  "key.rate_limit.changed": { family: "key", outcome: "success", phrase: "changed the rate limit for key", retention: "setup" },

  "domain.added": { family: "domain", outcome: "success", phrase: "added domain", retention: "setup" },
  "domain.adopted": { family: "domain", outcome: "success", phrase: "adopted the provider's existing domain", retention: "setup" },
  "domain.verified": { family: "domain", outcome: "success", phrase: "verified domain", retention: "setup" },
  "domain.deleted": { family: "domain", outcome: "success", phrase: "deleted domain", retention: "setup" },
  "domain.layout.changed": { family: "domain", outcome: "success", phrase: "changed the layout for domain", retention: "setup" },
  "domain.move.started": { family: "domain", outcome: "success", phrase: "started moving domain", retention: "setup" },
  "domain.move.cancelled": { family: "domain", outcome: "neutral", phrase: "cancelled the move for domain", retention: "setup" },
  "domain.stalled": { family: "domain", outcome: "neutral", phrase: "paused domain", retention: "churn" },
  "domain.stall.released": { family: "domain", outcome: "success", phrase: "released the pause on domain", retention: "churn" },
  "domain.reputation.changed": { family: "domain", outcome: "neutral", phrase: "changed the reputation standing of domain", retention: "churn" },
  "domain.dmarc_policy.recommended": { family: "domain", outcome: "neutral", phrase: "emailed owners the p=quarantine record for domain", retention: "churn" },
  "domain.dns.applied": { family: "domain", outcome: "success", phrase: "applied DNS records for domain", retention: "churn" },
  "domain.dns.removed": { family: "domain", outcome: "success", phrase: "removed DNS records for domain", retention: "churn" },
  "domain.inbound.enabled": { family: "domain", outcome: "success", phrase: "enabled inbound for domain", retention: "setup" },
  "domain.inbound.disabled": { family: "domain", outcome: "neutral", phrase: "disabled inbound for domain", retention: "setup" },
  "domain.bulk.enabled": { family: "domain", outcome: "success", phrase: "turned on bulk sending for domain", retention: "setup" },
  "domain.bulk.disabled": { family: "domain", outcome: "neutral", phrase: "turned off bulk sending for domain", retention: "setup" },

  "suppression.added": { family: "suppression", outcome: "success", phrase: "suppressed", retention: "setup" },
  "suppression.removed": {
    family: "suppression",
    outcome: "success",
    phrase: "removed the suppression on",
    plural: "removed suppressions on",
    counted: "removed {n} suppressions",
    retention: "setup",
  },
  "suppression.imported": { family: "suppression", outcome: "success", phrase: "imported suppressions", standalone: true, retention: "setup" },

  "settings.retention.changed": {
    family: "settings",
    outcome: "success",
    phrase: "changed body retention",
    standalone: true,
    retention: "setup",
  },
  "settings.address_limits.changed": {
    family: "settings",
    outcome: "success",
    phrase: "changed the address limits",
    standalone: true,
    retention: "setup",
  },
  "settings.name.changed": {
    family: "settings",
    outcome: "success",
    phrase: "renamed the organization",
    standalone: true,
    retention: "setup",
  },
  "settings.observation.muted": { family: "settings", outcome: "success", phrase: "muted", retention: "setup" },
  "settings.observation.unmuted": { family: "settings", outcome: "success", phrase: "unmuted", retention: "setup" },
  "settings.observation.turned_off": { family: "settings", outcome: "neutral", phrase: "turned off the observation", retention: "setup" },
  "settings.observation.turned_on": { family: "settings", outcome: "success", phrase: "turned on the observation", retention: "setup" },
  "settings.dmarc_reports.turned_off": { family: "settings", outcome: "neutral", phrase: "turned off DMARC reports", standalone: true, retention: "setup" },
  "settings.dmarc_reports.turned_on": { family: "settings", outcome: "success", phrase: "turned on DMARC reports", standalone: true, retention: "setup" },
  "member.role.changed": { family: "settings", outcome: "success", phrase: "changed the role of", retention: "setup" },
  "member.removed": { family: "settings", outcome: "neutral", phrase: "removed from the organization", retention: "setup" },
  "member.invited": { family: "settings", outcome: "success", phrase: "invited", retention: "setup" },
  "member.invitation.resent": { family: "settings", outcome: "success", phrase: "resent the invitation to", retention: "setup" },
  "member.invitation.revoked": { family: "settings", outcome: "neutral", phrase: "revoked the invitation to", retention: "setup" },
  "member.joined": { family: "settings", outcome: "success", phrase: "joined the organization", standalone: true, retention: "setup" },

  "webhook.endpoint.created": { family: "webhook", outcome: "success", phrase: "added webhook endpoint", retention: "setup" },
  "webhook.secret.revealed": { family: "webhook", outcome: "success", phrase: "revealed the secret for webhook endpoint", retention: "setup" },
  "webhook.secret.rotated": { family: "webhook", outcome: "success", phrase: "rotated the secret for webhook endpoint", retention: "setup" },
  "webhook.endpoint.disabled": { family: "webhook", outcome: "success", phrase: "disabled webhook endpoint", retention: "setup" },
  "webhook.endpoint.enabled": { family: "webhook", outcome: "success", phrase: "re-enabled webhook endpoint", retention: "setup" },
  "webhook.endpoint.deleted": { family: "webhook", outcome: "success", phrase: "deleted webhook endpoint", retention: "setup" },
  "webhook.endpoint.url.changed": { family: "webhook", outcome: "success", phrase: "changed the URL for webhook endpoint", retention: "setup" },

  "provider.created": { family: "provider", outcome: "success", phrase: "created provider", retention: "setup" },
  "provider.credentials.replaced": {
    family: "provider",
    outcome: "success",
    phrase: "replaced the credentials for provider",
    retention: "setup",
  },
  "provider.settings.changed": { family: "provider", outcome: "success", phrase: "changed settings for provider", retention: "setup" },
  "provider.deleted": { family: "provider", outcome: "success", phrase: "deleted provider", retention: "setup" },
  "provider.default.changed": { family: "provider", outcome: "success", phrase: "set the default provider to", retention: "setup" },
  "provider.shared.attached": { family: "provider", outcome: "success", phrase: "attached the organization to shared provider", retention: "setup" },
  "provider.shared.converted": { family: "provider", outcome: "success", phrase: "moved onto shared sending the provider", retention: "setup" },
  "provider.shared.detached": { family: "provider", outcome: "neutral", phrase: "detached the organization from shared provider", retention: "setup" },
  "provider.finding.opened": { family: "provider", outcome: "neutral", phrase: "reported a reputation finding on provider", retention: "churn" },
  "provider.finding.closed": { family: "provider", outcome: "success", phrase: "closed a reputation finding on provider", retention: "churn" },

  "session.signed_in": { family: "session", outcome: "success", phrase: "signed in", standalone: true, retention: "sign_in", client: SIGN_IN_CLIENT },
  "session.signed_out": { family: "session", outcome: "success", phrase: "signed out", standalone: true, retention: "sign_in" },
  "session.sign_in.failed": { family: "session", outcome: "failure", phrase: "failed to sign in", standalone: true, retention: "sign_in", client: SIGN_IN_CLIENT },
  "session.password_reset.requested": { family: "session", outcome: "neutral", phrase: "requested a password reset", standalone: true, retention: "sign_in" },
  "session.password_reset.completed": { family: "session", outcome: "success", phrase: "reset their password", standalone: true, retention: "sign_in" },
  "session.magic_link.requested": { family: "session", outcome: "neutral", phrase: "requested a sign-in link", standalone: true, retention: "sign_in", client: SIGN_IN_CLIENT },
  "session.emulation.started": { family: "session", outcome: "neutral", phrase: "started emulating this organization", standalone: true, retention: "setup" },
  "session.emulation.ended": { family: "session", outcome: "neutral", phrase: "stopped emulating this organization", standalone: true, retention: "setup" },

  "system.retention.swept": {
    family: "system",
    outcome: "success",
    phrase: "shredded message bodies past retention",
    standalone: true,
    retention: "churn",
  },
  "system.abandon.swept": {
    family: "system",
    outcome: "neutral",
    phrase: "marked messages as unconfirmed",
    standalone: true,
    retention: "churn",
  },
  "system.export.created": {
    family: "system",
    outcome: "success",
    phrase: "exported data",
    standalone: true,
    retention: "setup",
  },
  "organization.suspended": {
    family: "system",
    outcome: "neutral",
    phrase: "suspended sending for the organization",
    standalone: true,
    retention: null,
  },
  "organization.suspension.released": {
    family: "system",
    outcome: "success",
    phrase: "released the organization's suspension",
    standalone: true,
    retention: null,
  },
  "organization.reputation.changed": {
    family: "system",
    outcome: "neutral",
    phrase: "changed the organization's reputation standing",
    standalone: true,
    retention: "churn",
  },
  "notification.emailed": { family: "system", outcome: "neutral", phrase: "emailed owners", retention: "churn" },
  "system.feature.turned_on": { family: "system", outcome: "success", phrase: "turned on the feature", retention: "setup" },
  "system.feature.turned_off": { family: "system", outcome: "neutral", phrase: "turned off the feature", retention: "setup" },
  "system.setting.changed": { family: "system", outcome: "success", phrase: "changed the setting", retention: "setup" },
  "organization.created": { family: "system", outcome: "success", phrase: "created organization", retention: null },
  "organization.deleted": { family: "system", outcome: "neutral", phrase: "deleted organization", retention: null },
  "admin.granted": { family: "system", outcome: "success", phrase: "granted admin access to", retention: null },
  "admin.revoked": { family: "system", outcome: "neutral", phrase: "removed admin access from", retention: null },
  "account.deleted": { family: "system", outcome: "neutral", phrase: "deleted the account of", retention: null },
  "system.endpoint.auto_disabled": {
    family: "system",
    outcome: "neutral",
    phrase: "auto-disabled webhook endpoint",
    retention: "setup",
  },

  "list.created": { family: "list", outcome: "success", phrase: "created list", retention: "setup" },
  "list.updated": { family: "list", outcome: "success", phrase: "changed list", retention: "setup" },
  "list.deleted": { family: "list", outcome: "success", phrase: "deleted list", retention: "setup" },
  "list.member.added": { family: "list", outcome: "success", phrase: "added a member to list", retention: "churn" },
  "list.members.imported": { family: "list", outcome: "success", phrase: "imported members to list", retention: "churn" },
  "list.member.updated": { family: "list", outcome: "success", phrase: "changed a member's attributes on list", retention: "churn" },
  "list.member.removed": { family: "list", outcome: "success", phrase: "removed a member from list", retention: "churn" },
  "list.unsubscribed": { family: "list", outcome: "neutral", phrase: "unsubscribed an address from list", retention: "churn" },
  "domain.unsubscribed": { family: "list", outcome: "neutral", phrase: "unsubscribed an address from all mail on domain", retention: "churn" },
} as const satisfies Record<string, ActionDef>;

export type ActivityAction = keyof typeof ACTIVITY_ACTIONS;

export function isActivityAction(value: string): value is ActivityAction {
  return Object.hasOwn(ACTIVITY_ACTIONS, value);
}

export function familyFor(action: string): ActivityFamily {
  return isActivityAction(action) ? ACTIVITY_ACTIONS[action].family : "system";
}

export function outcomeFor(action: string): ActivityOutcome {
  return isActivityAction(action) ? ACTIVITY_ACTIONS[action].outcome : "neutral";
}

/** What a row of `action` may store of the client. Unknown actions store nothing. */
export function clientPolicyFor(action: string): { ipHash: boolean; userAgent: boolean } {
  return (isActivityAction(action) ? (ACTIVITY_ACTIONS[action] as ActionDef).client : undefined) ?? { ipHash: false, userAgent: false };
}

/** Each retention period with the actions it covers, under the operator's windows. Actions kept indefinitely are absent. */
export function retentionGroups(windows: RetentionWindows): { days: number; actions: ActivityAction[] }[] {
  const byDays = new Map<number, ActivityAction[]>();
  for (const action of Object.keys(ACTIVITY_ACTIONS) as ActivityAction[]) {
    const retention = (ACTIVITY_ACTIONS[action] as ActionDef).retention;
    if (retention === null) continue;
    const days = windowDays(retention, windows);
    byDays.set(days, [...(byDays.get(days) ?? []), action]);
  }
  return [...byDays].map(([days, actions]) => ({ days, actions }));
}

/** The verb phrase for a run over `subjects` subjects. */
export function phraseFor(action: string, subjects = 1): { text: string; standalone: boolean } {
  if (!isActivityAction(action)) return { text: action, standalone: false };
  const def: ActionDef = ACTIVITY_ACTIONS[action];
  return { text: subjects > 1 && def.plural ? def.plural : def.phrase, standalone: def.standalone ?? false };
}

/** The sentence for a run of `n` unnamed subjects, when the action has one: "removed 3 suppressions". */
export function countedPhraseFor(action: string, n: number): string | null {
  if (!isActivityAction(action)) return null;
  const def: ActionDef = ACTIVITY_ACTIONS[action];
  return def.counted ? def.counted.replace("{n}", formatNumber(n)) : null;
}

export const ALL_FAMILIES = [
  "key",
  "domain",
  "suppression",
  "settings",
  "webhook",
  "provider",
  "session",
  "system",
  "list",
] as const satisfies readonly ActivityFamily[];

export const FAMILY_LABELS: Record<ActivityFamily, string> = {
  key: "Keys",
  domain: "Domains",
  suppression: "Suppressions",
  settings: "Settings",
  webhook: "Webhooks",
  provider: "Providers",
  session: "Sign-in",
  system: "System",
  list: "Lists",
};

export function isFamily(value: string): value is ActivityFamily {
  return (ALL_FAMILIES as readonly string[]).includes(value);
}

export function isOutcome(value: string): value is ActivityOutcome {
  return value === "success" || value === "failure" || value === "neutral";
}
