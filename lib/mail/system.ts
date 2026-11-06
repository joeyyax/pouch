/**
 * Pouch's own mail: confirmations, layout previews and as-needed operator alerts, sent
 * through the same accept path as an organization's message so a bug in the send path shows up
 * in our own inbox first. Never operator alerts about the service being down — those are
 * push, per docs/engineering.md.
 *
 * One setting holds it: `service_settings.system_from_address`, a full address whose domain
 * has to be verified in some organization. That domain resolves the organization, its provider
 * and its tenant. Unset means `support@` on the oldest verified domain. The messages belong to
 * the service, never to that organization.
 */
import { asc, eq, sql } from "drizzle-orm";
import type { ReactElement } from "react";
import { db } from "@/lib/db";
import { domains, organizations } from "@/lib/db/schema";
import { domainOf, isEmailAddress, normalizeAddress } from "@/lib/addresses";
import { brand } from "@/lib/brand";
import { notifyQueued } from "@/lib/messages/queue";
import { sendEmailSchema, type SendEmailRequest } from "@/lib/schemas/email";
import { readServiceSettings } from "@/lib/settings/service";
import { renderSystemMail } from "./template";

/** Title-cased so it reads naturally on the wire; matching is case-insensitive. */
const LIST_UNSUBSCRIBE_HEADER_NAME = "List-Unsubscribe";

/** The setting a `SystemMailNotConfiguredError` names, and where an operator sets it. */
export const SYSTEM_FROM_ADDRESS_SETTING = "system from address";
export const SYSTEM_FROM_ADDRESS_SETTING_LOCATION = "Admin settings → General";

/** Local part the default address uses. Never `noreply@` — these invite a reply. */
export const SYSTEM_MAIL_LOCAL_PART = brand.supportAddress.split("@")[0] ?? "support";

/** The address system mail falls back to in copy that has no resolved domain to name. */
export const DEFAULT_SYSTEM_FROM_ADDRESS = brand.supportAddress;

/** Thrown when the system from address doesn't resolve to a verified domain. */
export class SystemMailNotConfiguredError extends Error {}

export interface SystemSender {
  /** The organization holding the domain. Its provider sends; the message is the service's. */
  organizationId: string;
  organizationName: string;
  domainId: string;
  domainName: string;
  fromAddress: string;
}

interface DomainRow {
  id: string;
  organizationId: string;
  organizationName: string;
  name: string;
  status: string;
}

function notConfigured(reason: string): SystemMailNotConfiguredError {
  return new SystemMailNotConfiguredError(
    `${reason} Set the ${SYSTEM_FROM_ADDRESS_SETTING} in ${SYSTEM_FROM_ADDRESS_SETTING_LOCATION}.`,
  );
}

function senderFor(domain: DomainRow, localPart: string): SystemSender {
  return {
    organizationId: domain.organizationId,
    organizationName: domain.organizationName,
    domainId: domain.id,
    domainName: domain.name,
    fromAddress: `${localPart}@${domain.name}`,
  };
}

const DOMAIN_COLUMNS = {
  id: domains.id,
  organizationId: domains.organizationId,
  organizationName: organizations.name,
  name: domains.name,
  status: domains.status,
};

/**
 * The domain carrying this name, verified first. Names are unique per organization rather than
 * across the install, so two organizations can hold the same one; the verified, oldest row wins
 * and the admin screen shows which organization that is.
 */
async function domainNamed(name: string): Promise<DomainRow | null> {
  const [domain] = await db
    .select(DOMAIN_COLUMNS)
    .from(domains)
    .innerJoin(organizations, eq(organizations.id, domains.organizationId))
    .where(eq(domains.name, name))
    .orderBy(sql`(${domains.status} = 'verified') desc`, asc(domains.createdAt), asc(domains.id))
    .limit(1);
  return domain ?? null;
}

/** `support@` on the oldest verified domain, which an unset setting falls back to. */
export async function defaultSystemSender(): Promise<SystemSender | null> {
  const [domain] = await db
    .select(DOMAIN_COLUMNS)
    .from(domains)
    .innerJoin(organizations, eq(organizations.id, domains.organizationId))
    .where(eq(domains.status, "verified"))
    .orderBy(asc(domains.createdAt), asc(domains.id))
    .limit(1);
  return domain ? senderFor(domain, SYSTEM_MAIL_LOCAL_PART) : null;
}

/**
 * Every verified domain name on the install, oldest first, deduplicated — two organizations can
 * hold the same name and the select offers one entry either way. The first is what an unset
 * setting falls back to.
 */
export async function listVerifiedDomainNames(): Promise<string[]> {
  const rows = await db
    .select({ name: domains.name })
    .from(domains)
    .where(eq(domains.status, "verified"))
    .orderBy(asc(domains.createdAt), asc(domains.id));
  return [...new Set(rows.map((row) => row.name))];
}

/**
 * Resolves one address to the organization that sends it. Throws
 * `SystemMailNotConfiguredError` naming the setting when the address isn't an address, or its
 * domain is missing or unverified. The admin action calls this before saving, so an address
 * that can't send is refused rather than stored.
 */
export async function resolveSystemSenderFor(address: string): Promise<SystemSender> {
  const normalized = normalizeAddress(address);
  if (!isEmailAddress(normalized)) throw notConfigured(`"${address}" isn't an email address.`);

  const name = domainOf(normalized);
  const domain = await domainNamed(name);
  if (!domain) throw notConfigured(`No organization holds the domain ${name}.`);
  if (domain.status !== "verified") throw notConfigured(`${name} isn't verified.`);

  return { ...senderFor(domain, SYSTEM_MAIL_LOCAL_PART), fromAddress: normalized };
}

/**
 * Resolves the setting at send time, so moving system mail to another address is a settings
 * change rather than a migration. Throws `SystemMailNotConfiguredError` naming the setting when
 * the setting is unset with no verified domain to fall back to, or its domain has since gone.
 */
export async function resolveSystemSender(): Promise<SystemSender> {
  const { systemFromAddress } = await readServiceSettings();
  if (systemFromAddress) return resolveSystemSenderFor(systemFromAddress);

  const fallback = await defaultSystemSender();
  if (!fallback) throw notConfigured(`No domain is verified on this install, so ${brand.name} has nowhere to send its own mail from.`);
  return fallback;
}

export interface SystemAlertInput {
  subject: string;
  /** The email, given the footer's reason: why each recipient gets alerts. */
  email: (reason: string) => ReactElement;
  /**
   * Ties this send to the state change that caused it, not to when it happened to run. The
   * 24-hour replay window makes a resend with the same key return the original message
   * instead of sending a second one; the caller's own state guard (an isNull(...) UPDATE, the
   * same idiom the activity log uses) is what stops a resend outside that window too.
   */
  idempotencyKey: string;
}

export interface SystemMailInput {
  to: string;
  subject: string;
  /** A component that renders `SystemMail`; both parts come from it. */
  email: ReactElement;
  headers?: Record<string, string>;
  tags: string[];
  idempotencyKey: string;
  /**
   * Set when the message carries a credential, completing "it contained ...": "a sign-in link".
   * No read returns the body, and the retention sweep shreds its key once the message has gone.
   */
  withhold?: string;
}

/**
 * Sends one message through the normal accept path, from the system from address, as the
 * service's own mail: no organization holds it, and Admin lists it. The shared primitive behind
 * `sendSystemAlert` and a digest. Throws SystemMailNotConfiguredError when the setting
 * doesn't resolve — callers must not let that take down the work that triggered the send.
 */
export async function sendSystemMail(input: SystemMailInput): Promise<void> {
  // Loaded here, not at the top: the accept path fires alerts through this adapter, so a static
  // import is a cycle. The one back edge from the mail stack into the accept path.
  const { acceptServiceMessage } = await import("@/lib/messages/create");
  const sender = await resolveSystemSender();

  const { html, text } = await renderSystemMail(input.email);
  const request: SendEmailRequest = sendEmailSchema.parse({
    from: `${brand.fromName} <${sender.fromAddress}>`,
    to: [input.to],
    subject: input.subject,
    html,
    text,
    headers: input.headers,
    tags: input.tags,
  });

  const { message, replayed } = await acceptServiceMessage(sender.organizationId, request, input.idempotencyKey, { withheld: input.withhold });
  if (!replayed) await notifyQueued(message.id).catch(() => {});
}

/**
 * Sends one as-needed alert through the normal accept path, from the system from address, to
 * the system alerts recipients (the from address itself when none are set), carrying
 * List-Unsubscribe. Throws SystemMailNotConfiguredError when the setting doesn't
 * resolve — callers must not let that take down the work that triggered the alert.
 */
export async function sendSystemAlert(input: SystemAlertInput): Promise<void> {
  const [{ fromAddress }, { systemAlertsTo }] = await Promise.all([resolveSystemSender(), readServiceSettings()]);
  const configured = systemAlertsTo && systemAlertsTo.length > 0 ? systemAlertsTo : null;

  // One message per recipient: each has its own log row and replay key, and one refused address
  // doesn't stop the rest.
  const failures: unknown[] = [];
  for (const to of configured ?? [fromAddress]) {
    try {
      await sendSystemMail({
        to,
        subject: input.subject,
        email: input.email(
          configured
            ? `You get this because ${to} is a system alerts recipient in ${SYSTEM_FROM_ADDRESS_SETTING_LOCATION}.`
            : `You get this because alerts go to the system from address until ${SYSTEM_FROM_ADDRESS_SETTING_LOCATION} names a recipient.`,
        ),
        headers: { [LIST_UNSUBSCRIBE_HEADER_NAME]: `<mailto:${fromAddress}>` },
        tags: ["system-alert"],
        idempotencyKey: configured ? `${input.idempotencyKey}:${to}` : input.idempotencyKey,
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
}

/** True when the system from address resolves to a verified domain. */
export async function systemMailReady(): Promise<boolean> {
  try {
    await resolveSystemSender();
    return true;
  } catch (error) {
    if (error instanceof SystemMailNotConfiguredError) return false;
    throw error;
  }
}

/** The domain name a from-address resolves to. */
export function systemDomainFor(fromAddress: string): string {
  return domainOf(fromAddress);
}
