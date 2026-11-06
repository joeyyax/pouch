import type { SystemMailBody } from "@/lib/mail/template";

export interface DmarcPolicyReadyInput {
  domainName: string;
  /** Healthy days in a row behind the suggestion. */
  days: number;
  record: { name: string; value: string };
  /** Absolute link to the domain's Reputation page. */
  url: string;
}

export function dmarcPolicyReadySubject(input: DmarcPolicyReadyInput): string {
  return `Next step for ${input.domainName}: p=quarantine`;
}

export function dmarcPolicyReadyMail(input: DmarcPolicyReadyInput): SystemMailBody {
  return {
    heading: `${input.domainName} is ready for p=quarantine`,
    paragraphs: [
      `DMARC reports for ${input.domainName} have read healthy for ${input.days} days in a row. Your mail passes and no one else sends as the domain in numbers worth flagging.`,
      "Its record is p=none, which only watches. p=quarantine tells receivers to send mail that fails DMARC to spam. To move to it, replace the published record with this one. Only p changes.",
    ],
    facts: [
      ["Type", "TXT"],
      ["Name", input.record.name],
      ["Value", input.record.value],
    ],
    action: { label: "See the reports", url: input.url },
    reason: `You get this as an owner of the organization that holds ${input.domainName}. It comes once, and again only if the policy goes back to p=none.`,
  };
}
