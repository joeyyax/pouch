import { Alert } from "@/components/ui/alert";

export const UNASSIGNED_TITLE = "This organization can't send yet";
export const UNASSIGNED_BODY = "An admin needs to assign it a provider.";

/** Shown wherever sending starts while the organization has no assigned provider. */
export function UnassignedAlert({ className }: { className?: string }) {
  return (
    <Alert tone="warn" title={UNASSIGNED_TITLE} className={className}>
      <p>{UNASSIGNED_BODY}</p>
    </Alert>
  );
}
