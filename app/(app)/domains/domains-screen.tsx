"use client";

import { useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { FieldMessage } from "@/components/ui/field-message";
import { fieldClasses } from "@/components/ui/field";
import { Chip } from "@/components/ui/chip";
import { Modal } from "@/components/ui/modal";
import type { DomainListItem, ProviderOption } from "@/lib/dashboard/views/domains";
import { INACTIVE_ROW, settled } from "../_ui/inactive";
import { PageHeader } from "../_ui/page-header";
import { Sparkline } from "../_ui/sparkline";
import { DomainChip, StandingChip, standingNote } from "../_ui/status";
import { Term } from "../_ui/term";
import { useAction } from "../_ui/use-action";
import { RoleGate } from "../_ui/role-gate";
import { UNASSIGNED_BODY, UNASSIGNED_TITLE, UnassignedAlert } from "../_ui/unassigned-alert";
import { addDomainAction } from "./actions";
import { formatNumber } from "@/lib/format/number";

const columns: DataTableColumn<DomainListItem>[] = [
  {
    key: "name",
    header: "Domain",
    priority: "primary",
    cell: (row) => <span className="font-mono">{row.name}</span>,
  },
  {
    key: "status",
    header: "Status",
    priority: "primary",
    cell: (row) => (
      <span className="flex items-center gap-1.5">
        {row.status === "verified" ? (
          <StandingChip shape="dot" standing={row.standing} explain={standingNote(row.standing, row.standingReason)} />
        ) : (
          <DomainChip shape="dot" status={row.status} />
        )}
        {row.moving ? (
          <Term chip term="moving">
            <Chip tone="signal">moving</Chip>
          </Term>
        ) : null}
      </span>
    ),
  },
  {
    key: "provider",
    header: "Provider",
    cell: (row) => <span className="text-muted-foreground">{row.providerName}</span>,
  },
  {
    key: "delivered",
    header: "Delivered 7d",
    numeric: true,
    cell: (row) => (
      <span className="flex items-center justify-end gap-3">
        {row.delivered > 0 ? (
          <Sparkline
            values={row.deliveredDaily}
            label={`${row.name} delivered per day`}
            color="var(--success)"
            interactive={false}
            className="h-5 w-16"
          />
        ) : null}
        <span className={row.delivered > 0 ? "tabular-nums" : "tabular-nums text-muted-foreground"}>
          {formatNumber(row.delivered)}
        </span>
      </span>
    ),
  },
  {
    key: "keys",
    header: "Keys",
    numeric: true,
    cell: (row) => <span className="tabular-nums">{row.keyCount}</span>,
  },
];

/** Pending past the settling window: abandoned, not being set up. A failure or a move needs attention, so it never dims. */
function abandoned(row: DomainListItem): boolean {
  return row.status === "pending" && !row.moving && row.stall === null && settled(row.createdAt);
}

export function DomainsScreen({
  rows,
  providers,
  adding,
  canManage,
}: {
  rows: DomainListItem[];
  providers: ProviderOption[];
  adding: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const heading = useRef<HTMLHeadingElement>(null);

  function setAdding(next: boolean) {
    const query = new URLSearchParams(params);
    if (next) query.set("state", "add");
    else query.delete("state");
    const suffix = query.toString();
    router.push(suffix ? `/domains?${suffix}` : "/domains", { scroll: false });
  }

  const assigned = providers.some((provider) => provider.assigned);
  const addGate = assigned
    ? { allowed: canManage, reason: "Your role doesn't let you add a domain." }
    : { allowed: false, reason: `${UNASSIGNED_TITLE}. ${UNASSIGNED_BODY}` };

  const verified = rows.filter((row) => row.status === "verified").length;

  return (
    <>
      <PageHeader
        titleRef={heading}
        title="Domains"
        description="Sends from an unverified domain fail at the API."
        meta={rows.length > 0 ? `${verified} of ${rows.length} verified.` : undefined}
        actions={
          <RoleGate {...addGate}>
            <Button size="md" onClick={() => setAdding(true)}>
              Add domain
            </Button>
          </RoleGate>
        }
      />

      {assigned ? null : <UnassignedAlert className="mb-6" />}

      <Card className="overflow-hidden p-0">
        <DataTable
          label="Domains"
          columns={columns}
          rows={rows}
          getRowKey={(row) => row.id}
          onRowClick={(row) => router.push(`/domains/${row.id}`, { scroll: false })}
          rowClassName={(row) => (abandoned(row) ? INACTIVE_ROW : undefined)}
          empty={
            <EmptyState
              icon="globe"
              title="No domains yet"
              description="Add one, set its DNS records and it can send."
              action={
                <RoleGate {...addGate}>
                  <Button size="md" onClick={() => setAdding(true)}>
                    Add domain
                  </Button>
                </RoleGate>
              }
            />
          }
        />
      </Card>

      {adding && canManage ? (
        <Modal
          open
          onOpenChange={(open) => !open && setAdding(false)}
          title="Add domain"
          description="Next you add the DNS records it lists and verify. It stays pending until they resolve."
        >
          <AddDomainForm providers={providers} onCancel={() => setAdding(false)} />
        </Modal>
      ) : null}
    </>
  );
}

const inputClass = `${fieldClasses({ shape: "compact", size: "md" })} w-full font-mono`;

export function AddDomainForm({
  providers,
  onCancel,
}: {
  providers: ProviderOption[];
  onCancel: () => void;
}) {
  // Every error renders in the form, so none is toasted. Success redirects.
  const { state, formAction, pending } = useAction(addDomainAction, () => {});
  const [name, setName] = useState("");
  const assigned = providers.find((provider) => provider.assigned) ?? null;
  const usable = providers.filter((provider) => provider.canAddDomains);
  const only = usable.length === 1 ? usable[0] : null;
  const blocked = !assigned || usable.length === 0;
  const providerError = state.status === "error" && state.field === "provider_id" ? state.message : undefined;

  return (
    <form action={formAction} className="flex flex-col gap-5">
      {!assigned ? (
        <UnassignedAlert />
      ) : usable.length === 0 ? (
        <FieldMessage tone="error">
          {assigned.name} can&rsquo;t add a domain through its API. An admin needs to add it in the provider&rsquo;s
          dashboard first.
        </FieldMessage>
      ) : null}

      <Field
        id="domain-name"
        label="Domain"
        hint="The name can't change once it's added."
        error={state.status === "error" && state.field !== "provider_id" ? state.message : undefined}
      >
        <input
          id="domain-name"
          name="name"
          type="text"
          placeholder="example.com"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={inputClass}
          autoComplete="off"
          spellCheck={false}
          required
          disabled={blocked}
        />
      </Field>

      {usable.length > 1 ? (
        <Field
          id="domain-provider"
          label="Provider"
          hint="A domain sends through one provider. You can move it later."
          error={providerError}
        >
          <select
            id="domain-provider"
            name="providerId"
            className={inputClass}
            defaultValue={assigned?.canAddDomains ? assigned.id : undefined}
            required
          >
            {usable.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name} · {provider.adapterLabel}
              </option>
            ))}
          </select>
        </Field>
      ) : only && assigned ? (
        <div>
          <p className="type-body-sm text-foreground-soft" data-sends-through>
            Sends through <span className="text-foreground">{only.name}</span>{" "}
            <span className="text-muted-foreground">· {only.adapterLabel}</span>
          </p>
          {only.id === assigned.id ? null : <input type="hidden" name="providerId" value={only.id} />}
          {providerError ? <FieldMessage tone="error">{providerError}</FieldMessage> : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="secondary" size="md" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="md" disabled={pending || blocked}>
          {pending ? "Adding…" : "Add domain"}
        </Button>
      </div>
    </form>
  );
}
