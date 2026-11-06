"use client";

import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { StatusDot, sentenceCase, type StatusDotTone } from "@/components/ui/status-dot";
import type { DnsPlan, DnsPlanStep, DnsPlanVerdict } from "@/lib/domains/dns-plan";
import { recordKey } from "@/lib/dashboard/views/domains";
import { CopyOnHover } from "../_ui/copy-on-hover";
import { RoleGate } from "../_ui/role-gate";
import { useAction } from "../_ui/use-action";
import { applyDnsPlanAction } from "./actions";
import type { ActionState } from "@/lib/dashboard/action-state";

const VERDICT_LABEL: Record<DnsPlanVerdict, string> = {
  create: "not published",
  already_correct: "already correct",
  merge: "needs merge",
  conflict: "conflict",
};

const VERDICT_TONE: Record<DnsPlanVerdict, StatusDotTone> = {
  create: "warn",
  already_correct: "good",
  merge: "warn",
  conflict: "issue",
};

function PlanStepRow({ step }: { step: DnsPlanStep }) {
  return (
    <li className="flex flex-col gap-1.5 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Chip tone="value">{step.record.type}</Chip>
        <span className="min-w-0 flex-1 font-mono text-sm text-foreground [overflow-wrap:anywhere]">{step.record.name}</span>
        <StatusDot tone={VERDICT_TONE[step.verdict]}>{sentenceCase(VERDICT_LABEL[step.verdict])}</StatusDot>
      </div>
      <p className="type-body-sm text-foreground-soft">{step.reason}</p>
      {step.verdict === "merge" && step.merge ? (
        <CopyOnHover value={step.merge.mechanisms} label="mechanisms to add" className="font-mono text-sm text-foreground" wrap>
          {step.merge.mechanisms}
        </CopyOnHover>
      ) : null}
      {step.verdict === "conflict"
        ? step.observed.map((observed) => (
            <CopyOnHover
              key={`${observed.type}:${observed.name}:${observed.value}`}
              value={observed.value}
              label={`published ${observed.type} value`}
              className="font-mono text-sm text-foreground-soft"
             wrap>
              {observed.value}
            </CopyOnHover>
          ))
        : null}
    </li>
  );
}

/**
 * The reconciliation plan against the live zone, with a button to publish it. Sits beside the
 * plain record list (`DnsRecords`) rather than replacing it — a `conflict` step never offers to
 * overwrite, it points at the same list for the operator to publish by hand.
 *
 * Publishing re-reads the live zone and re-runs the plan server-side (see
 * lib/domains/dns-apply.ts) rather than trusting what's rendered here, so this view never sends
 * a record back to the server — only the domain id. Applying is idempotent, so the same button
 * is the retry: an already-applied or already-correct step is a no-op the second time.
 *
 * `applyAction` defaults to the ordinary domain's publish action; a pending provider
 * move (#212) passes `applyPendingDnsPlanAction` so the same view publishes the *pending*
 * binding's required records instead, coexisting with whatever the current account still has
 * published.
 */
export function DnsPlanCardView({
  plan,
  domainId,
  canManage,
  applyAction = applyDnsPlanAction,
}: {
  plan: DnsPlan;
  domainId: string;
  canManage: boolean;
  applyAction?: (state: ActionState, form: FormData) => Promise<ActionState>;
}) {
  const apply = useAction(applyAction);

  if (plan.status === "no_account") {
    return (
      <p className="type-body-sm text-muted-foreground">
        No DNS provider account is connected. Connect one to compare these records with the live zone and publish them.
      </p>
    );
  }

  if (plan.status === "zone_not_found") {
    return (
      <p className="type-body-sm text-muted-foreground">
        The connected DNS provider account doesn&apos;t have a zone for this domain.
      </p>
    );
  }

  if (plan.status === "unreachable") {
    return <p className="type-body-sm text-muted-foreground">{plan.detail ?? "Couldn't reach the DNS provider."}</p>;
  }

  if (plan.steps.length === 0) {
    return <p className="type-body-sm text-muted-foreground">This domain has no required records to reconcile.</p>;
  }

  const conflicts = plan.steps.filter((step) => step.verdict === "conflict").length;
  const publishable = plan.steps.filter((step) => step.verdict === "create" || step.verdict === "merge").length;
  const alreadyCorrect = plan.steps.length - conflicts - publishable;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="type-body-sm text-muted-foreground">
          {conflicts > 0
            ? `${alreadyCorrect} of ${plan.steps.length} already published. ${conflicts} ${conflicts === 1 ? "needs" : "need"} a human.`
            : publishable > 0
              ? `${alreadyCorrect} of ${plan.steps.length} already published.`
              : `${plan.steps.length} of ${plan.steps.length} already published.`}
        </p>
        {publishable > 0 ? (
          <form action={apply.formAction}>
            <input type="hidden" name="id" value={domainId} />
            <RoleGate allowed={canManage} reason="Your role doesn't let you publish DNS records.">
              <Button type="submit" variant="primary" size="sm" disabled={apply.pending}>
                {apply.pending ? "Publishing…" : `Publish ${publishable} ${publishable === 1 ? "record" : "records"}`}
              </Button>
            </RoleGate>
          </form>
        ) : null}
      </div>
      <ul className="flex flex-col divide-y divide-border">
        {plan.steps.map((step) => (
          <PlanStepRow key={recordKey(step.record)} step={step} />
        ))}
      </ul>
    </div>
  );
}
