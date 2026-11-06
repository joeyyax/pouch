import { Alert } from "@/components/ui/alert";
import type { OrganizationSuspension } from "@/lib/suspension";
import { holdsQueue } from "@/lib/suspension/sources";
import { timeLabel } from "@/lib/format/time";

export function SuspensionBanner({ suspension, zone }: { suspension: OrganizationSuspension; zone: string }) {
  const held = holdsQueue(suspension.source);
  return (
    <div className="pb-4">
      <Alert tone="danger" title="Sending is suspended for this organization">
        <p>{suspension.reason}</p>
        <p className="mt-1 text-muted-foreground">
          Suspended {timeLabel(suspension.suspendedAt, zone)}. New sends are refused with <code>organization_suspended</code>
          {suspension.source === "provider"
            ? " and queued messages wait. An admin is working with the provider, and queued mail sends once the pause lifts."
            : held
              ? " and queued messages wait until an admin releases the suspension. Contact an admin to lift it."
              : " and queued messages fail. Contact an admin to lift it."}
        </p>
      </Alert>
    </div>
  );
}
