/**
 * The invitation email. Sent from the system from address, the same path a password reset takes.
 */
import { createHash } from "node:crypto";
import { baseUrl } from "@/lib/api/urls";
import { brand } from "@/lib/brand";
import { sendSystemMail } from "@/lib/mail/system";
import { createElement } from "react";
import { SystemMail, systemMailText, type SystemMailBody } from "@/lib/mail/template";

export const ACCEPT_INVITATION_PAGE = "/accept";

/** The link in the email: the app's own accept screen. */
export function invitationLinkFor(token: string): string {
  const link = new URL(ACCEPT_INVITATION_PAGE, baseUrl());
  link.searchParams.set("token", token);
  return link.toString();
}

export interface InvitationMailInput {
  to: string;
  organizationName: string;
  /** Omitted when an admin key sent it, which is a key's name, not a person's. */
  invitedByName?: string;
  link: string;
  expiresAt: Date;
  /** True when the address already has an account and accepting means signing in. */
  hasAccount: boolean;
}

/** Days left, rounded up, so "1 day" never reads as an invitation that's already gone. */
function daysUntil(expiresAt: Date): number {
  return Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
}

export function invitationSubject(organizationName: string): string {
  return `${organizationName} invited you to ${brand.name}`;
}

export function invitationMail(input: InvitationMailInput): SystemMailBody {
  const days = daysUntil(input.expiresAt);
  const window = days === 1 ? "1 day" : `${days} days`;
  const inviter = input.invitedByName ?? `Someone at ${input.organizationName}`;

  return {
    heading: `Join ${input.organizationName} on ${brand.name}`,
    paragraphs: [
      input.invitedByName ? `${input.invitedByName} invited you to ${input.organizationName}.` : `You're invited to ${input.organizationName}.`,
      `${brand.name} is where ${input.organizationName} sends its transactional email. Joining gives you its domains, keys and message log.`,
      input.hasAccount ? `You already have an account for ${input.to}, so sign in to join.` : "Open the link to set a password and join.",
    ],
    action: { label: input.hasAccount ? "Sign in and join" : "Accept invitation", url: input.link },
    note: `The link works once and expires in ${window}.`,
    reason: `You got this because ${inviter} invited ${input.to}. Not expecting it? Ignore this email. Nothing happens until you open the link.`,
  };
}

export function invitationMailText(input: InvitationMailInput): string {
  return systemMailText(invitationMail(input));
}

/** Throws when the system from address isn't set up, or the send is refused. */
export async function sendInvitationMail(input: InvitationMailInput): Promise<void> {
  await sendSystemMail({
    to: input.to,
    subject: invitationSubject(input.organizationName),
    email: createElement(SystemMail, invitationMail(input)),
    tags: ["invitation"],
    withhold: "an invitation link",
    idempotencyKey: `invitation:${createHash("sha256").update(input.link).digest("hex")}`,
  });
}
