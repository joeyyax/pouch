import { brand } from "@/lib/brand";
import { systemMailText, type SystemMailBody } from "@/lib/mail/template";
import { alertTone, STANDING_LABEL, type AlertTone, type Finding, type Standing } from "@/lib/reputation/standing";

export type ReputationAlertKind = "entered" | "released";

export interface ReputationAlertInput {
  kind: ReputationAlertKind;
  subjectType: "domain" | "organization";
  subjectName: string;
  standing: Standing;
  findings: Finding[];
  /** Absolute link to the page that shows the detail. */
  url: string;
  changedAt: Date;
}

export function reputationAlertSubject(input: ReputationAlertInput): string {
  if (input.kind === "released") return `Sending resumed: ${input.subjectName}`;
  if (input.standing === "paused") return `Sending paused: ${input.subjectName}`;
  return `${SUBJECT[alertTone(input.findings)]}: ${input.subjectName}`;
}

const SUBJECT: Record<AlertTone, string> = {
  pausing: "At risk of pausing",
  listed: "On a blocklist",
  look: "Worth a look",
};

function atRiskLead(tone: AlertTone, noun: string, name: string): string {
  if (tone === "look") return `Sending on the ${noun} ${name} looks different from usual. Nothing is paused, and this won't pause it.`;
  if (tone === "listed") return `Some mailbox providers may junk or refuse mail from the ${noun} ${name}. ${brand.name} isn't pausing it.`;
  return `The ${noun} ${name} is close to the point where ${brand.name} pauses its sending, and past that, where the provider reviews or pauses it.`;
}

export function reputationAlertMail(input: ReputationAlertInput): SystemMailBody {
  const noun = input.subjectType === "domain" ? "domain" : "organization";
  const lead =
    input.kind === "released"
      ? `Sending from the ${noun} ${input.subjectName} has resumed. Its standing is now ${STANDING_LABEL[input.standing].toLowerCase()}.`
      : input.standing === "paused"
        ? `${brand.name} paused sending from the ${noun} ${input.subjectName}. Queued mail is held until the pause is released.`
        : atRiskLead(alertTone(input.findings), noun, input.subjectName);

  return {
    heading: reputationAlertSubject(input),
    paragraphs: [lead],
    sections: input.findings.map((finding) => ({ title: finding.title, lines: [finding.body, `What to do: ${finding.action}`] })),
    action: { label: "See details", url: input.url },
    reason: `You get this as an owner of the organization that holds ${input.subjectName}.`,
  };
}

export function reputationAlertText(input: ReputationAlertInput): string {
  return systemMailText(reputationAlertMail(input));
}
