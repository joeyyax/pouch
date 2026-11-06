"use client";

import { keepValues } from "../../_ui/keep-values";
import { RoleGate } from "../../_ui/role-gate";
import { Button } from "@/components/ui/button";
import { Field, fieldClasses } from "@/components/ui/field";
import type { OrganizationSummary } from "@/lib/dashboard/views/service";
import { toast } from "@/lib/toast";
import { useAction } from "../../_ui/use-action";
import { updateOrganizationSettingsAction } from "../actions";

export function OrganizationSettingsSection({
  organization,
  retentionCeiling,
  canManage,
}: {
  organization: OrganizationSummary;
  retentionCeiling: number;
  canManage: boolean;
}) {
  const capped = organization.bodyRetentionDays > retentionCeiling;
  // A field error shows on its field.
  const save = useAction(updateOrganizationSettingsAction, (state) => {
    if (state.status === "ok") toast({ title: state.message, variant: "success" });
    if (state.status === "error" && !state.field) toast({ title: state.message, variant: "error" });
  });

  return (
    <form onSubmit={keepValues(save.formAction)} className="flex flex-col gap-4">
      <div className="max-w-[24rem]">
        <Field
          id="name"
          label="Name"
          hint="Shown across the dashboard. The slug doesn't change."
          error={save.state.status === "error" && save.state.field === "name" ? save.state.message : undefined}
        >
          <input
            id="name"
            name="name"
            type="text"
            maxLength={200}
            required
            defaultValue={organization.name}
            className={`${fieldClasses({ shape: "compact", size: "md" })} w-full`}
          />
        </Field>
      </div>

      <div className="max-w-[14rem]">
        <Field
          id="bodyRetentionDays"
          label="Body retention"
          hint={
            capped
              ? `Capped at ${retentionCeiling} days by this install's admin, so bodies stay readable ${retentionCeiling} days. Set 7 to ${retentionCeiling}.`
              : `Days a body stays readable, 7 to ${retentionCeiling}. Sent bodies follow at the next sweep.`
          }
          error={
            save.state.status === "error" && save.state.field === "body_retention_days" ? save.state.message : undefined
          }
        >
          <input
            id="bodyRetentionDays"
            name="bodyRetentionDays"
            type="number"
            min={7}
            max={retentionCeiling}
            required
            defaultValue={organization.bodyRetentionDays}
            className={`${fieldClasses({ shape: "compact", size: "md" })} w-full`}
          />
        </Field>
      </div>

      <div>
        <RoleGate allowed={canManage} reason="You need to be an owner to change organization settings.">
          <Button type="submit" size="md" loading={save.pending}>
            Save changes
          </Button>
        </RoleGate>
      </div>
    </form>
  );
}
