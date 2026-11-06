"use client";

import { brand } from "@/lib/brand";
import { startTransition, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { StatusDot, sentenceCase, type StatusDotTone } from "@/components/ui/status-dot";
import type { ActionState } from "@/lib/dashboard/action-state";
import type { DnsCleanupPlan, DnsCleanupStep } from "@/lib/domains/dns-cleanup";
import { CopyOnHover } from "../_ui/copy-on-hover";
import { RoleGate } from "../_ui/role-gate";
import { useAction } from "../_ui/use-action";
import { removeDnsCleanupAction } from "./actions";

const ACTION_LABEL: Record<DnsCleanupStep["action"], string> = {
  delete: "delete",
  edit: "edit",
};

function stepTone(step: DnsCleanupStep): StatusDotTone {
  if (step.status === "refused") return "good";
  return step.action === "delete" ? "issue" : "warn";
}

function stepLabel(step: DnsCleanupStep): string {
  if (step.status === "refused") return "left alone";
  return step.action === "delete" ? "will delete" : "will edit";
}

function CleanupStepRow({ step }: { step: DnsCleanupStep }) {
  return (
    <li className="flex flex-col gap-1.5 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Chip tone="value">{step.type}</Chip>
        <span className="min-w-0 flex-1 font-mono text-sm text-foreground [overflow-wrap:anywhere]">{step.name}</span>
        <StatusDot tone={stepTone(step)}>{sentenceCase(stepLabel(step))}</StatusDot>
      </div>
      <p className="type-body-sm text-foreground-soft">{step.reason}</p>
      {step.action === "edit" && step.resultingValue ? (
        <CopyOnHover value={step.resultingValue} label="value after removal" className="font-mono text-sm text-foreground-soft" wrap>
          {step.resultingValue}
        </CopyOnHover>
      ) : null}
    </li>
  );
}

/**
 * What Pouch can remove from this domain's live zone, and the confirm step that's the whole
 * safety story for doing it (docs/design/registrar-integration.md): the operator sees exactly
 * what deletes, what edits, and what's left alone before anything happens.
 *
 * Confirming re-reads the live zone and re-classifies server-side (lib/domains/dns-cleanup.ts)
 * rather than trusting what's rendered here, so a record that's changed since this plan was
 * fetched is refused at removal time even if it showed as removable a moment ago.
 *
 * `title`/`description`/`removeAction` default to #211's whole-domain cleanup. The post-cutover
 * "previous account" cleanup (#212) passes its own copy and `removePreviousAccountCleanupAction`
 * so the same confirm-and-remove flow only ever offers that account's stale records.
 */
export function DnsCleanupCardView({
  plan,
  domainId,
  domainName,
  canManage,
  title = "Clean up DNS records",
  description = `Every record ${brand.name} wrote to this domain that's still safe to remove. A record changed since then is left alone.`,
  removeAction = removeDnsCleanupAction,
}: {
  plan: DnsCleanupPlan;
  domainId: string;
  domainName: string;
  canManage: boolean;
  title?: string;
  description?: string;
  removeAction?: (state: ActionState, form: FormData) => Promise<ActionState>;
}) {
  const remove = useAction(removeAction);
  const [confirming, setConfirming] = useState(false);

  if (plan.status === "unreachable") {
    return (
      <section className="flex flex-col gap-3 border-t border-border pt-6">
        <h2 className="type-title text-base text-foreground">{title}</h2>
        <p className="type-body-sm text-muted-foreground">{plan.detail ?? "Couldn't reach the DNS provider."}</p>
      </section>
    );
  }

  if (plan.status !== "ready" || plan.steps.length === 0) return null;

  const removable = plan.steps.filter((step) => step.status === "removable");
  const refused = plan.steps.length - removable.length;
  const deletes = removable.filter((step) => step.action === "delete").length;
  const edits = removable.filter((step) => step.action === "edit").length;

  const consequence =
    deletes > 0 && edits > 0
      ? `Deletes ${deletes} ${deletes === 1 ? "record" : "records"} and edits ${edits} ${edits === 1 ? "record" : "records"} in ${domainName}'s live zone.`
      : deletes > 0
        ? `Deletes ${deletes} ${deletes === 1 ? "record" : "records"} from ${domainName}'s live zone.`
        : `Edits ${edits} ${edits === 1 ? "record" : "records"} in ${domainName}'s live zone.`;

  return (
    <section className="flex flex-col gap-3 border-t border-border pt-6">
      <div className="flex flex-col gap-1">
        <h2 className="type-title text-base text-foreground">{title}</h2>
        <p className="type-body-sm text-muted-foreground">{description}</p>
      </div>
      <ul className="flex flex-col divide-y divide-border">
        {plan.steps.map((step) => (
          <CleanupStepRow key={step.id} step={step} />
        ))}
      </ul>
      {removable.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="type-body-sm text-muted-foreground">
            {removable.length} of {plan.steps.length} safe to remove.
            {refused > 0 ? ` ${refused} left alone.` : ""}
          </p>
          <RoleGate allowed={canManage} reason="Your role doesn't let you remove DNS records.">
            <Button type="button" variant="danger" size="sm" onClick={() => setConfirming(true)} disabled={remove.pending}>
              Review and remove
            </Button>
          </RoleGate>
        </div>
      ) : (
        <p className="type-body-sm text-muted-foreground">
          {refused} of {plan.steps.length} have changed since {brand.name} wrote them. Nothing here is safe to remove.
        </p>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Remove ${removable.length} DNS ${removable.length === 1 ? "record" : "records"} from ${domainName}?`}
        consequence={consequence}
        confirmLabel="Remove records"
        tone="destructive"
        loading={remove.pending}
        onConfirm={() => {
          const form = new FormData();
          form.set("id", domainId);
          startTransition(() => remove.formAction(form));
          setConfirming(false);
        }}
        cancelLabel="Cancel"
      >
        <ul className="mt-2 flex flex-col gap-1 text-sm text-foreground-soft">
          {removable.map((step) => (
            <li key={step.id} className="font-mono">
              {ACTION_LABEL[step.action]} {step.type} {step.name}
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </section>
  );
}
