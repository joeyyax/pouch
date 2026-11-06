"use client";

import { keepValues } from "../_ui/keep-values";
import Link from "next/link";
import { useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusDot } from "@/components/ui/status-dot";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, fieldClasses } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { EMPTY_MEMBER_COUNTS, type MemberCounts } from "@/lib/dashboard/views/lists";
import type { SerializedList } from "@/lib/lists/serialize";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { INACTIVE_ROW, settled } from "../_ui/inactive";
import { PageHeader } from "../_ui/page-header";
import { Term } from "../_ui/term";
import { Time } from "../_ui/time";
import { useAction } from "../_ui/use-action";
import { createListAction } from "./actions";
import { formatNumber } from "@/lib/format/number";

interface DomainOption {
  id: string;
  name: string;
  verified: boolean;
}

/** Zeros recede so the lists with members stand out. */
function Count({ value }: { value: number }) {
  return <span className={cn("tabular-nums", value === 0 ? "text-muted-foreground" : null)}>{formatNumber(value)}</span>;
}

function listColumns(counts: Record<string, MemberCounts>, domainName: Map<string, string>): DataTableColumn<SerializedList>[] {
  const of = (list: SerializedList) => counts[list.id] ?? EMPTY_MEMBER_COUNTS;
  return [
    {
      key: "name",
      header: "List",
      priority: "primary",
      cellClassName: "w-full max-w-0",
      cell: (list) => (
        <Link href={`/lists/${list.id}`} className="block truncate font-medium underline underline-offset-4 hover:no-underline">
          {list.name}
        </Link>
      ),
    },
    { key: "domain", header: "Domain", priority: "detail", cell: (list) => domainName.get(list.domain_id) ?? list.domain_id },
    {
      key: "opt-in",
      header: "Opt-in",
      priority: "detail",
      cell: (list) =>
        list.double_opt_in ? (
          <StatusDot>Double</StatusDot>
        ) : (
          <StatusDot tone="warn">
            <Term term="single_opt_in">Single</Term>
          </StatusDot>
        ),
    },
    { key: "subscribed", header: "Subscribed", numeric: true, priority: "primary", cell: (list) => <Count value={of(list).subscribed} /> },
    { key: "pending", header: <Term term="pending_member">Pending</Term>, numeric: true, priority: "detail", cell: (list) => <Count value={of(list).pending} /> },
    { key: "unsubscribed", header: "Unsubscribed", numeric: true, priority: "detail", cell: (list) => <Count value={of(list).unsubscribed} /> },
    {
      key: "created",
      header: "Created",
      numeric: true,
      priority: "detail",
      cellClassName: "whitespace-nowrap",
      cell: (list) => <Time date={new Date(list.created_at)} />,
    },
  ];
}

/** Nobody subscribed or confirming, past the settling window. A single opt-in list keeps its warning. */
function inactive(list: SerializedList, counts: MemberCounts): boolean {
  return counts.subscribed === 0 && counts.pending === 0 && list.double_opt_in && settled(list.created_at);
}

export function ListsScreen({
  lists,
  counts,
  total,
  nextCursor,
  paged,
  domains,
}: {
  lists: SerializedList[];
  counts: Record<string, MemberCounts>;
  total: number;
  nextCursor: string | null;
  paged: boolean;
  domains: DomainOption[];
}) {
  const [creating, setCreating] = useState(false);
  // A field error shows on its field. A success redirects to the new list.
  const { state, formAction, pending } = useAction(createListAction, (next) => {
    if (next.status === "error" && !next.field) toast({ title: next.message, variant: "error" });
  });
  const fieldError = (field: string) => (state.status === "error" && state.field === field ? state.message : undefined);
  const domainName = new Map(domains.map((domain) => [domain.id, domain.name]));
  const verified = domains.filter((domain) => domain.verified);

  return (
    <>
      <PageHeader
        title="Lists"
        description="Addresses for bulk sends. They join by subscribe, import or a manual add."
        meta={`${formatNumber(total)} ${total === 1 ? "list" : "lists"}.`}
        actions={
          <Button size="md" onClick={() => setCreating(true)}>
            New list
          </Button>
        }
      />

      {lists.length === 0 ? (
        <EmptyState
          icon="inbox"
          title="No lists yet"
          description="A list holds addresses for bulk sends. Create one, or add subscribe to a send and it grows on its own."
          action={
            <Button size="md" onClick={() => setCreating(true)}>
              New list
            </Button>
          }
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <DataTable
            columns={listColumns(counts, domainName)}
            rows={lists}
            getRowKey={(list) => list.id}
            label="Lists"
            rowClassName={(list) => (inactive(list, counts[list.id] ?? EMPTY_MEMBER_COUNTS) ? INACTIVE_ROW : undefined)}
          />
        </Card>
      )}

      {paged || nextCursor ? (
        <div className="mt-4 flex items-center justify-between text-sm">
          {paged ? (
            <Link href="/lists" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Newest
            </Link>
          ) : (
            <span />
          )}
          {nextCursor ? (
            <Link
              href={`/lists?${new URLSearchParams({ cursor: nextCursor }).toString()}`}
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              Older
            </Link>
          ) : null}
        </div>
      ) : null}

      {creating ? (
        <Modal
          open
          onOpenChange={(open) => !open && setCreating(false)}
          title="New list"
          description="A list holds addresses for bulk sends, on one verified domain."
        >
          <form onSubmit={keepValues(formAction)} className="flex flex-col gap-5">
            <Field
              id="list-domain"
              label="Domain"
              hint={verified.length === 0 ? "No domain is verified yet. Verify one to create a list on it." : undefined}
              error={fieldError("domain_id")}
            >
              <select
                id="list-domain"
                name="domain_id"
                required
                defaultValue={verified.length === 1 ? verified[0]?.id : ""}
                className={`${fieldClasses({ shape: "compact", size: "md" })} w-full`}
              >
                <option value="">Choose a domain</option>
                {verified.map((domain) => (
                  <option key={domain.id} value={domain.id}>
                    {domain.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="list-name" label="Name" error={fieldError("name")}>
              <input id="list-name" name="name" type="text" required autoFocus placeholder="Newsletter" className={`${fieldClasses({ shape: "compact", size: "md" })} w-full`} />
            </Field>
            <label className="flex items-start gap-2 text-sm text-foreground-soft">
              <input type="checkbox" name="double_opt_in" value="true" defaultChecked className="mt-0.5" />
              Double opt-in. New members confirm before they receive a batch.
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="md" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button type="submit" size="md" loading={pending} disabled={verified.length === 0}>
                Create list
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
