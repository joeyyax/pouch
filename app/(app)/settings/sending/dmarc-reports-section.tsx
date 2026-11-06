"use client";

import { startTransition } from "react";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { RoleGate } from "../../_ui/role-gate";
import { SectionHeader } from "../../_ui/section-header";
import { useAction } from "../../_ui/use-action";
import { setDmarcReportsEnabledAction } from "../actions";

export interface DmarcReportsSetting {
  /** False until an admin sets up the report host. */
  available: boolean;
  enabled: boolean;
}

export function DmarcReportsSection({ setting, canManage }: { setting: DmarcReportsSetting; canManage: boolean }) {
  const toggle = useAction(setDmarcReportsEnabledAction);

  function setOn(checked: boolean) {
    const form = new FormData();
    form.set("enabled", String(checked));
    startTransition(() => toggle.formAction(form));
  }

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader title="DMARC reports" description="Who sends as your domains, from the reports mailbox providers send back." />
      <Card className="flex items-center justify-between gap-4 p-5">
        <p className="type-body-sm min-w-0 text-foreground-soft">
          {setting.available
            ? "Each domain's recommended DMARC record carries its own report address, and its Reputation page reads the reports."
            : "An admin hasn't set up DMARC reports on this install."}
        </p>
        {setting.available ? (
          <RoleGate allowed={canManage} reason="You need to be an owner to change DMARC reports.">
            <Switch checked={setting.enabled} onCheckedChange={setOn} disabled={toggle.pending} aria-label="DMARC reports" />
          </RoleGate>
        ) : null}
      </Card>
    </section>
  );
}
