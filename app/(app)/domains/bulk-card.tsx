"use client";

import { startTransition } from "react";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useAction } from "../_ui/use-action";
import { RoleGate } from "../_ui/role-gate";
import { setBulkAllowedAction } from "./actions";

export function BulkCard({
  domainId,
  bulkAllowed,
  bulkCapable,
  canManage,
}: {
  domainId: string;
  bulkAllowed: boolean;
  /** Whether this domain's provider adapter can do bulk at all. */
  bulkCapable: boolean;
  canManage: boolean;
}) {
  const { formAction, pending } = useAction(setBulkAllowedAction);

  function toggle(checked: boolean) {
    const form = new FormData();
    form.set("id", domainId);
    form.set("allowed", String(checked));
    startTransition(() => formAction(form));
  }

  const roleReason = "Your role doesn't let you change this domain's bulk setting.";
  const capabilityReason = "This domain's provider has no bulk API. Move it to one that does to turn this on.";

  return (
    <Card className="flex items-center justify-between gap-4 p-5">
      <div className="min-w-0">
        <h2 className="type-title text-base text-foreground">Bulk sending</h2>
        <p className="type-body-sm mt-1 text-muted-foreground">
          Lets this domain send through <span className="font-mono">POST /v1/batches</span>: lists, double
          opt-in and unsubscribes.
        </p>
        {!bulkCapable ? <p className="type-body-sm mt-1 text-muted-foreground">{capabilityReason}</p> : null}
      </div>
      <RoleGate allowed={canManage && bulkCapable} reason={!canManage ? roleReason : capabilityReason}>
        <Switch
          checked={bulkAllowed}
          onCheckedChange={toggle}
          disabled={pending || !bulkCapable}
          aria-label="Bulk sending"
        />
      </RoleGate>
    </Card>
  );
}
