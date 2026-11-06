import { formatNumber } from "@/lib/format/number";
import { messagesHref } from "@/lib/messages/link";
import { BASELINE_DAYS, readVolumeShift, roughly } from "@/lib/metrics/volume";
import { defineObservation, type Finding } from "./_types";

export interface QuietTagFinding extends Finding {
  tag: string;
  /** Mean live sends a day across the baseline. */
  average: number;
}

function usual(average: number): string {
  return `None sent in the last day, against about ${formatNumber(roughly(average))} a day over the previous ${BASELINE_DAYS} days.`;
}

function wording({ tag, average }: QuietTagFinding) {
  return {
    title: `The ${tag} tag went quiet`,
    body: usual(average),
    links: [{ href: messagesHref({ tag, days: BASELINE_DAYS + 1 }), label: "See earlier messages" }],
  };
}

/**
 * A tag that sent every day of its baseline and nothing in the last day, by the domain rule in
 * `lib/metrics/volume.ts`. Left out when every domain that carried it went quiet too: the domain's own condition covers it.
 */
export const tagQuiet = defineObservation<"tag_quiet", QuietTagFinding>({
  key: "tag_quiet",
  title: "Tag gone quiet",
  description: "A tag that sends every day sends nothing for a day.",
  tone: "info",
  mutableBy: ["tag"],
  example: { tag: "order-confirmation", average: 320, tags: ["order-confirmation"], keyIds: [] },

  async evaluate(context) {
    const volumes = await context.tagVolumes();
    return volumes.flatMap((volume): QuietTagFinding[] => {
      const reading = readVolumeShift(volume.lastDay, volume.baseline);
      if (reading?.shift !== "stopped") return [];
      if (volume.baselineDomains.every((domain) => !domain.sending)) return [];
      return [{ tag: volume.tag, average: reading.average, tags: [volume.tag], keyIds: [] }];
    });
  },

  condition: wording,

  notice(finding) {
    return { about: [`tag:${finding.tag}`], wording: wording(finding) };
  },

  digestLine({ tag, average }) {
    return { text: `the ${tag} tag went quiet. ${usual(average)}`, path: messagesHref({ tag, days: BASELINE_DAYS + 1 }) };
  },
});
