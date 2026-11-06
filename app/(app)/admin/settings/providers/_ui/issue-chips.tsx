import { Chip, type ChipTone } from "@/components/ui/chip";
import type { AdminProviderIssue } from "@/lib/dashboard/admin-providers";

export const ISSUE_LABEL: Record<AdminProviderIssue, { label: string; tone: ChipTone }> = {
  needs_conversion: { label: "Needs conversion", tone: "signal" },
  setting_up: { label: "Setting up", tone: "warn" },
  credentials_failing: { label: "Credentials failing", tone: "issue" },
  backing_off: { label: "Backing off", tone: "warn" },
  quota: { label: "Quota 80%", tone: "warn" },
};

export function IssueChips({ issues }: { issues: AdminProviderIssue[] }) {
  return (
    <>
      {issues.map((issue) => (
        <Chip key={issue} tone={ISSUE_LABEL[issue].tone}>
          {ISSUE_LABEL[issue].label}
        </Chip>
      ))}
    </>
  );
}
