"use client";

import { startTransition, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { fieldClasses } from "@/components/ui/field";
import type { DomainPendingBinding, ProviderOption } from "@/lib/dashboard/views/domains";
import { dayLabel } from "@/lib/format/time";
import { useAction } from "../_ui/use-action";
import { useTimeZone } from "../_ui/time-zone";
import { RoleGate } from "../_ui/role-gate";
import { cancelMoveAction, moveDomainAction } from "./actions";
import { DnsRecords } from "./dns-records";

const inputClass = `${fieldClasses({ shape: "compact", size: "md" })} w-full`;

/**
 * Shows which provider this domain sends through, and either the move it's mid-way through or, with a
 * second assignment, a way to start one. A move is staged (#35): starting one never stops the domain sending on its
 * current provider, so there's no confirmation step for starting one — only for cancelling, since
 * cancelling drops the identity the target provider created.
 */
export function ProviderCard({
  domainId,
  domainName,
  current,
  pending,
  providers,
  canManage,
  liveRecords,
  pendingDnsPlan,
  previousProviderCleanup,
}: {
  domainId: string;
  domainName: string;
  current: { id: string; name: string; adapterLabel: string };
  pending: DomainPendingBinding | null;
  providers: ProviderOption[];
  canManage: boolean;
  /** A live-check element per record in `pending.dnsRecords`, keyed by `recordKey`. */
  liveRecords: Record<string, ReactNode>;
  /** The reconciliation plan for `pending.dnsRecords`, resolved server-side. Null while there's no pending move. */
  pendingDnsPlan: ReactNode;
  /** What's safe to remove from the previous provider's provenance, resolved server-side. Null when there's nothing to show. */
  previousProviderCleanup: ReactNode;
}) {
  const zone = useTimeZone();
  const move = useAction(moveDomainAction);
  const cancel = useAction(cancelMoveAction);
  const [choosing, setChoosing] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const usable = providers.filter((provider) => provider.canAddDomains && provider.id !== current.id);

  if (pending) {
    return (
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="type-title text-base text-foreground">Provider</h2>
        </div>

        <dl className="flex flex-col gap-2 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">Sending on</dt>
            <dd className="min-w-0 text-right text-foreground">
              {current.name} <span className="text-muted-foreground">· {current.adapterLabel}</span>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">Moving to</dt>
            <dd className="min-w-0 text-right text-foreground">
              {pending.providerName} <span className="text-muted-foreground">· {pending.adapterLabel}</span>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">Started</dt>
            <dd className="text-right text-foreground-soft">{dayLabel(pending.startedAt, zone)}</dd>
          </div>
        </dl>

        <p className="type-body-sm text-muted-foreground">
          {domainName} keeps sending on {current.name} until {pending.providerName} verifies. Publish these records
          alongside the live ones.
        </p>

        <DnsRecords
          title={`Records for ${pending.providerName}`}
          records={pending.dnsRecords}
          missing={pending.missingRecords}
          checked
          liveSlots={liveRecords}
        />

        {pendingDnsPlan}

        <div className="flex justify-end">
          <RoleGate allowed={canManage} reason="Your role doesn't let you cancel a domain move.">
            <Button variant="secondary" size="sm" onClick={() => setCancelling(true)}>
              Cancel move
            </Button>
          </RoleGate>
        </div>

        <ConfirmDialog
          open={cancelling}
          onOpenChange={setCancelling}
          title="Cancel this move?"
          consequence={`${domainName} keeps sending on ${current.name}. The domain set up at ${pending.providerName} is dropped.`}
          confirmLabel="Cancel move"
          tone="destructive"
          loading={cancel.pending}
          onConfirm={() => {
            const form = new FormData();
            form.set("id", domainId);
            startTransition(() => cancel.formAction(form));
            setCancelling(false);
          }}
          cancelLabel="Keep it"
        />
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="type-title text-base text-foreground">Provider</h2>
        {!choosing && usable.length > 0 && canManage ? (
          <Button variant="secondary" size="sm" onClick={() => setChoosing(true)}>
            Move to another provider
          </Button>
        ) : null}
      </div>

      <p className="type-body-sm text-foreground-soft">
        Sending on <span className="text-foreground">{current.name}</span>{" "}
        <span className="text-muted-foreground">· {current.adapterLabel}</span>
      </p>

      {choosing ? (
        <form
          action={move.formAction}
          className="flex flex-col gap-3 border-t border-border pt-4"
          onSubmit={() => setChoosing(false)}
        >
          <input type="hidden" name="id" value={domainId} />
          <label htmlFor="move-provider" className="type-label text-muted-foreground">
            Move to
          </label>
          <select id="move-provider" name="providerId" className={inputClass} required>
            {usable.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name} · {provider.adapterLabel}
              </option>
            ))}
          </select>
          <p className="type-body-sm text-muted-foreground">
            {domainName} keeps sending on {current.name} until the new provider verifies.
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setChoosing(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={move.pending}>
              {move.pending ? "Starting…" : "Start move"}
            </Button>
          </div>
        </form>
      ) : null}

      {previousProviderCleanup}
    </Card>
  );
}
