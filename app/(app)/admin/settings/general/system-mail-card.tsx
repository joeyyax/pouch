"use client";

import { keepValues } from "../../../_ui/keep-values";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { Field, fieldClasses } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import type { SystemMailView } from "@/lib/dashboard/admin-general";
import { SectionHeader } from "../../../_ui/section-header";
import { useAction } from "../../../_ui/use-action";
import { setSystemAlertsToAction, setSystemFromAddressAction } from "./actions";

/** Radix refuses an empty item value, so "unset" travels as a sentinel and submits as blank. */
const UNSET = "__default__";

export function SystemMailCard({ view }: { view: SystemMailView }) {
  const save = useAction(setSystemFromAddressAction);
  const saveAlerts = useAction(setSystemAlertsToAction);
  // Controlled, so a refused save keeps what was typed.
  const [localPart, setLocalPart] = useState(view.localPart ?? "");
  const [domain, setDomain] = useState(view.domain ?? UNSET);
    const [alertsTo, setAlertsTo] = useState(view.alertsTo.join(", "));
  const none = view.verifiedDomains.length === 0;
  const error = save.state.status === "error" ? save.state : null;
  const alertsError = saveAlerts.state.status === "error" ? saveAlerts.state : null;
  const alertsFallback = view.resolved?.address ?? view.address ?? "the system from address";

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        title="System mail"
        description="Password resets, system alerts and digests send from this address. The organization that verified its domain sends them, and Status → System mail lists them."
      />
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center gap-2">
          {view.resolved ? (
            <>
              <span className="type-body-sm text-muted-foreground">Sending from</span>
              <span className="font-mono text-sm text-foreground">{view.resolved.address}</span>
              <span className="type-body-sm text-muted-foreground">in {view.resolved.organizationName}</span>
            </>
          ) : (
            <>
              <Chip tone="issue">not configured</Chip>
              <span className="type-body-sm text-muted-foreground">{view.problem}</span>
            </>
          )}
        </div>
        {none ? (
          <p className="type-body-sm text-muted-foreground">
            No verified domains yet. Verify one in any organization and it shows up here.
          </p>
        ) : (
          <form onSubmit={keepValues(save.formAction)} className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-3">
              <Field
                id="localPart"
                label="From address"
                error={error?.field === "localPart" ? error.message : undefined}
                className="min-w-0"
              >
                <input
                  id="localPart"
                  name="localPart"
                  placeholder="support"
                  value={localPart}
                  onChange={(event) => setLocalPart(event.target.value)}
                  className={`${fieldClasses({ shape: "compact", size: "md" })} w-40`}
                />
              </Field>
              <span className="type-body-sm pb-3 text-muted-foreground">@</span>
              <Field
                id="domain"
                label="Domain"
                error={error?.field === "domain" ? error.message : undefined}
                className="min-w-0"
              >
                <input type="hidden" name="domain" value={domain === UNSET ? "" : domain} />
                <Select
                  id="domain"
                  items={[
                    { value: UNSET, label: "Use the default" },
                    ...view.verifiedDomains.map((name) => ({ value: name, label: name })),
                  ]}
                  value={domain}
                  onValueChange={setDomain}
                  size="md"
                  shape="compact"
                  triggerClassName="w-64"
                />
              </Field>
            </div>
            <p className="type-body-sm text-muted-foreground">
              The default is <span className="font-mono">support@{view.verifiedDomains[0]}</span>, the oldest verified
              domain.
            </p>
            <div>
              <Button type="submit" size="md" loading={save.pending}>
                Save
              </Button>
            </div>
          </form>
        )}
        <form onSubmit={keepValues(saveAlerts.formAction)} className="flex flex-col gap-4 border-t border-border pt-4">
          <Field
            id="alertsTo"
            label="System alerts to"
            error={alertsError?.message}
            hint={`Addresses, separated by commas. Blank sends alerts to ${alertsFallback}.`}
            className="min-w-0"
          >
            <input
              id="alertsTo"
              name="alertsTo"
              type="text"
              placeholder="you@example.com, ops@example.com"
              value={alertsTo}
              onChange={(event) => setAlertsTo(event.target.value)}
              className={`${fieldClasses({ shape: "compact", size: "md" })} w-full max-w-xl`}
            />
          </Field>
          <div>
            <Button type="submit" size="md" loading={saveAlerts.pending}>
              Save
            </Button>
          </div>
        </form>
      </Card>
    </section>
  );
}
