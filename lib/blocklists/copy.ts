/** Dashboard copy for the check's state. Pure, so client components can use it. */
import type { BlocklistStatus } from "./status";

export interface BlocklistStatusCopy {
  label: string;
  tone: "good" | "warn" | "neutral";
  text: string;
  /** Set in code font after the text. */
  code?: string;
}

export function describeBlocklistStatus(status: BlocklistStatus): BlocklistStatusCopy {
  switch (status.state) {
    case "off":
      return {
        label: "Off",
        tone: "neutral",
        text: "Blocklist checks need a Spamhaus DQS key. An admin sets it as",
        code: "SPAMHAUS_DQS_KEY",
      };
    case "no_redis":
      return { label: "Off", tone: "neutral", text: "Blocklist checks need Redis to count queries against Spamhaus's daily limit." };
    case "key_invalid":
      return { label: "Paused", tone: "warn", text: `${status.detail} Checks resume once the key works.` };
    case "paused":
      return { label: "Paused", tone: "warn", text: "Today's Spamhaus query budget is used. Checks resume at 00:00 UTC." };
    case "on":
      return {
        label: "On",
        tone: "good",
        text: "Sending domains are checked daily against Spamhaus DBL and ZRD. Links are checked as mail sends.",
      };
  }
}
