// Every kind of email owners get about their organization: who gets it, how often and its template.
import { dmarcPolicyReadyMail, dmarcPolicyReadySubject, type DmarcPolicyReadyInput } from "@/lib/mail/dmarc-policy-ready";
import { reputationAlertMail, reputationAlertSubject, type ReputationAlertInput } from "@/lib/mail/alerts/reputation-changed";
import {
  deliveryTimeMail,
  deliveryTimeSubject,
  observationNoticeMail,
  observationNoticeSubject,
  type DeliveryTimeInput,
  type ObservationNoticeInput,
} from "@/lib/mail/notices";
import type { SystemMailBody } from "@/lib/mail/template";
import { settingDef, type SettingKey } from "@/lib/settings/registry";

export type Throttle =
  /** Once per subject until the condition clears, and never again inside `minHours`. Held in `notification_sends`. */
  | { kind: "until_clear"; minHours: number }
  /** The caller claims each send against its own state, described in `rule`. */
  | { kind: "caller"; rule: string };

export interface NotificationDef<I> {
  audience: "owners";
  /** Without a preference row or an operator switch, the type sends. */
  default: boolean;
  throttle: Throttle;
  /** The tag on each message, when it isn't the type's key. */
  tag?: string;
  subject(input: I): string;
  mail(input: I): SystemMailBody;
}

function define<I>(def: NotificationDef<I>): NotificationDef<I> {
  return def;
}

const STANDING_THROTTLE: Throttle = {
  kind: "caller",
  rule: "reputation_states: a worse standing always sends; the standing last emailed waits standing_alert_repeat_hours",
};

export const NOTIFICATIONS = {
  standing_at_risk: define<ReputationAlertInput>({
    audience: "owners",
    default: true,
    throttle: STANDING_THROTTLE,
    tag: "reputation-alert",
    subject: reputationAlertSubject,
    mail: reputationAlertMail,
  }),
  standing_paused: define<ReputationAlertInput>({
    audience: "owners",
    default: true,
    throttle: STANDING_THROTTLE,
    tag: "reputation-alert",
    subject: reputationAlertSubject,
    mail: reputationAlertMail,
  }),
  standing_resumed: define<ReputationAlertInput>({
    audience: "owners",
    default: true,
    throttle: STANDING_THROTTLE,
    tag: "reputation-alert",
    subject: reputationAlertSubject,
    mail: reputationAlertMail,
  }),
  account_targeted: define<ObservationNoticeInput>({
    audience: "owners",
    default: true,
    throttle: { kind: "until_clear", minHours: 24 },
    subject: observationNoticeSubject,
    mail: observationNoticeMail,
  }),
  tag_quiet: define<ObservationNoticeInput>({
    audience: "owners",
    default: true,
    throttle: { kind: "until_clear", minHours: 24 },
    subject: observationNoticeSubject,
    mail: observationNoticeMail,
  }),
  domain_spoofed: define<ObservationNoticeInput>({
    audience: "owners",
    default: true,
    throttle: { kind: "until_clear", minHours: 7 * 24 },
    subject: observationNoticeSubject,
    mail: observationNoticeMail,
  }),
  delivery_time: define<DeliveryTimeInput>({
    audience: "owners",
    default: true,
    throttle: { kind: "until_clear", minHours: 7 * 24 },
    subject: deliveryTimeSubject,
    mail: deliveryTimeMail,
  }),
  dmarc_policy_ready: define<DmarcPolicyReadyInput>({
    audience: "owners",
    default: true,
    throttle: { kind: "caller", rule: "dmarc_domain_tokens.policy_ready_notified_at: once, again after the policy moves past none" },
    subject: dmarcPolicyReadySubject,
    mail: dmarcPolicyReadyMail,
  }),
};

export type NotificationType = keyof typeof NOTIFICATIONS;

export type NotificationInput<T extends NotificationType> = (typeof NOTIFICATIONS)[T] extends NotificationDef<infer I> ? I : never;

export const NOTIFICATION_TYPES = Object.keys(NOTIFICATIONS) as NotificationType[];

export function isNotificationType(value: string): value is NotificationType {
  return Object.hasOwn(NOTIFICATIONS, value);
}

/** The operator's switch for a type. */
export function notificationSetting(type: NotificationType): SettingKey {
  return `notification_${type}` as SettingKey;
}

/** The name and description people see, from the type's operator switch. */
export function notificationLabel(type: NotificationType): { label: string; description: string } {
  const { label, description } = settingDef(notificationSetting(type));
  return { label, description };
}
