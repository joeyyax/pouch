import { baseUrl } from "@/lib/api/urls";
import type { SystemMailBody } from "@/lib/mail/template";
import type { ObservationWording } from "@/lib/observations/_types";

export interface ObservationNoticeInput {
  organizationName: string;
  /** The observation's own wording, links relative to the dashboard. */
  wording: ObservationWording;
}

export function observationNoticeSubject(input: ObservationNoticeInput): string {
  return input.wording.title;
}

export function observationNoticeMail(input: ObservationNoticeInput): SystemMailBody {
  const [link] = input.wording.links;
  return {
    heading: input.wording.title,
    paragraphs: [input.wording.body],
    ...(link ? { action: { label: link.label, url: `${baseUrl()}${link.href}` } } : {}),
    reason: `You get this as an owner of ${input.organizationName}. It comes once while this holds.`,
  };
}

export interface DeliveryTimeInput {
  domainName: string;
  title: string;
  body: string;
  action: string;
  /** Absolute link to the domain's Reputation page. */
  url: string;
}

export function deliveryTimeSubject(input: DeliveryTimeInput): string {
  return input.title;
}

export function deliveryTimeMail(input: DeliveryTimeInput): SystemMailBody {
  return {
    heading: input.title,
    paragraphs: [input.body, `What to do: ${input.action}`],
    action: { label: "See details", url: input.url },
    reason: `You get this as an owner of the organization that holds ${input.domainName}. It comes once while delivery stays slow.`,
  };
}
