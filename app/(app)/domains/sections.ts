import type { DomainStatus } from "@/lib/db/schema";
import type { Standing } from "@/lib/reputation/standing";

export const DOMAIN_SECTIONS = ["setup", "sending", "reputation"] as const;
export type DomainSection = (typeof DOMAIN_SECTIONS)[number];

export const SECTION_LABEL: Record<DomainSection, string> = {
  setup: "Setup",
  sending: "Sending",
  reputation: "Reputation",
};

/** Setup until it verifies, Reputation once standing is Watch or worse, otherwise Sending. */
export function defaultSection(status: DomainStatus, standing: Standing | null): DomainSection {
  if (status !== "verified") return "setup";
  if (standing && standing !== "healthy") return "reputation";
  return "sending";
}
