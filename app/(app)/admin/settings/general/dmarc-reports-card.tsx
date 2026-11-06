"use client";

import { keepValues } from "../../../_ui/keep-values";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { Field, fieldClasses } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { StatusDot, type StatusDotTone } from "@/components/ui/status-dot";
import { TextLink } from "@/components/ui/text-link";
import type { DmarcReportHostView } from "@/lib/dashboard/admin-general";
import { CopyOnHover } from "../../../_ui/copy-on-hover";
import { SectionHeader } from "../../../_ui/section-header";
import { useAction } from "../../../_ui/use-action";
import { checkDmarcReportHostAction, setDmarcReportHostAction } from "./actions";

const VERDICT: Record<string, { tone: StatusDotTone; label: string }> = {
  match: { tone: "good", label: "Published" },
  different: { tone: "issue", label: "Different value" },
  missing: { tone: "warn", label: "Not published" },
  unresolved: { tone: "neutral", label: "Couldn’t check" },
};

export function DmarcReportsCard({ view }: { view: DmarcReportHostView }) {
  const save = useAction(setDmarcReportHostAction);
  const check = useAction(checkDmarcReportHostAction);
  const [host, setHost] = useState(view.host ?? "");
  const [providerId, setProviderId] = useState(view.providerId ?? view.options[0]?.id ?? "");
  const error = save.state.status === "error" ? save.state : null;

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        title="DMARC reports"
        description="Mailbox providers send each domain's aggregate reports to an address on this host. Once its records check out, every domain's recommended DMARC record carries its own address."
      />
      <Card className="flex flex-col gap-4 p-5">
        {view.host ? (
          <div className="flex flex-wrap items-center gap-2">
            {view.verified ? <Chip tone="good">receiving</Chip> : <Chip tone="warn">waiting on DNS</Chip>}
            <span className="font-mono text-sm text-foreground">{view.host}</span>
          </div>
        ) : null}
        {view.options.length === 0 ? (
          <p className="type-body-sm text-muted-foreground">
            No shared provider routes received mail through its API, so reports have nowhere to land. An SES provider with an inbound bucket can; set one up in{" "}
            <TextLink href="/admin/settings/providers">Providers</TextLink>.
          </p>
        ) : (
          <form onSubmit={keepValues(save.formAction)} className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-3">
              <Field id="host" label="Report host" error={error?.field === "host" ? error.message : undefined} hint="A host nothing else receives on. Blank turns reports off." className="min-w-0">
                <input
                  id="host"
                  name="host"
                  placeholder="reports.example.com"
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                  className={`${fieldClasses({ shape: "compact", size: "md" })} w-72`}
                />
              </Field>
              <Field id="providerId" label="Received by" error={error?.field === "providerId" ? error.message : undefined} className="min-w-0">
                <input type="hidden" name="providerId" value={providerId} />
                <Select
                  id="providerId"
                  items={view.options.map((option) => ({ value: option.id, label: `${option.name} · ${option.adapterLabel}` }))}
                  value={providerId}
                  onValueChange={setProviderId}
                  size="md"
                  shape="compact"
                  triggerClassName="w-64"
                />
              </Field>
            </div>
            {error && !error.field ? <p className="type-body-sm text-danger">{error.message}</p> : null}
            <div>
              <Button type="submit" size="md" loading={save.pending}>
                Save
              </Button>
            </div>
          </form>
        )}
        {view.records.length > 0 ? (
          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <p className="type-body-sm text-foreground-soft">Publish these at the host’s DNS.</p>
            <ul className="flex flex-col divide-y divide-border">
              {view.records.map((record) => (
                <li key={`${record.type}:${record.name}`} className="flex flex-col gap-1 py-2.5">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Chip tone="value">{record.type}</Chip>
                    <CopyOnHover value={record.name} label={`${record.type} name`} className="font-mono text-sm text-foreground" wrap always>
                      {record.name}
                    </CopyOnHover>
                    <StatusDot tone={VERDICT[record.verdict]?.tone ?? "neutral"}>{VERDICT[record.verdict]?.label ?? record.verdict}</StatusDot>
                  </span>
                  <CopyOnHover value={record.value} label={`${record.type} value`} className="font-mono text-sm text-foreground-soft" wrap always>
                    {record.priority === undefined ? record.value : `${record.priority} ${record.value}`}
                  </CopyOnHover>
                  {record.verdict === "different" && record.observed.length > 0 ? (
                    <span className="type-body-sm text-muted-foreground">Found {record.observed.join(", ")}</span>
                  ) : null}
                </li>
              ))}
            </ul>
            <form action={check.formAction}>
              <Button type="submit" size="md" variant="secondary" loading={check.pending}>
                Check again
              </Button>
            </form>
          </div>
        ) : null}
      </Card>
    </section>
  );
}
