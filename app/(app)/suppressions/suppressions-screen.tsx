"use client";

import { keepValues } from "../_ui/keep-values";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusDot, type StatusDotTone } from "@/components/ui/status-dot";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, fieldClasses } from "@/components/ui/field";
import { FilterBar, type FilterBarChip } from "@/components/ui/filter-bar";
import { Select } from "@/components/ui/select";
import { Modal } from "@/components/ui/modal";
import { IconButton } from "@/components/ui/icon-button";
import {
  REASON_LABEL,
  removalConsequence,
  SUPPRESSION_TREND_DAYS,
  SUPPRESSIONS_PAGE_SIZE,
  suppressionListQuery,
} from "@/lib/dashboard/views/suppressions";
import type {
  SuppressionListFilters,
  SuppressionListItem,
  SuppressionPage,
  SuppressionSummary,
} from "@/lib/dashboard/views/suppressions";
import { SUPPRESSION_REASONS } from "@/lib/db/enums";
import type { SuppressionReason } from "@/lib/db/schema/suppressions";
import { cn } from "@/lib/utils";
import { useOpenerFocus } from "@/hooks/use-opener-focus";
import { CopyOnHover } from "../_ui/copy-on-hover";
import { OverflowMenu } from "../_ui/overflow-menu";
import { PageHeader } from "../_ui/page-header";
import { ROW_ACTION } from "../_ui/row-action";
import { RankedList } from "../_ui/ranked-list";
import { SectionHeader } from "../_ui/section-header";
import { Sparkline } from "../_ui/sparkline";
import { SearchDegradedNote } from "../_ui/search-degraded-note";
import { Time } from "../_ui/time";
import { toast } from "@/lib/toast";
import { useAction } from "../_ui/use-action";
import { addSuppressionAction, removeSuppressionAction } from "./actions";
import { ImportPanel } from "./import-panel";
import { useRef, useState } from "react";
import { formatNumber } from "@/lib/format/number";

// A hard bounce and a complaint are the provider's word; a manual add is ours.
const REASON_TONE: Record<SuppressionReason, StatusDotTone> = {
  hard_bounce: "issue",
  complaint: "issue",
  manual: "neutral",
};

export type SuppressionScreenFilters = Omit<SuppressionListFilters, "page" | "search">;

const REASON_OPTIONS = [
  { value: "all", label: "Any reason" },
  ...SUPPRESSION_REASONS.map((reason) => ({ value: reason, label: REASON_LABEL[reason] })),
];

export function SuppressionsScreen({
  results,
  summary,
  search,
  filters,
  domainNames,
  panel,
  canRemove,
}: {
  results: SuppressionPage;
  summary: SuppressionSummary;
  search: string;
  filters: SuppressionScreenFilters;
  domainNames: string[];
  panel: "add" | "import" | null;
  canRemove: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const remove = useAction(removeSuppressionAction);
  const [confirming, setConfirming] = useState<SuppressionListItem | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useOpenerFocus(heading);

  const { rows, total, page, pageCount } = results;
  const first = total === 0 ? 0 : (page - 1) * SUPPRESSIONS_PAGE_SIZE + 1;
  const last = (page - 1) * SUPPRESSIONS_PAGE_SIZE + rows.length;

  function setParams(patch: Record<string, string>) {
    const query = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value) query.set(key, value);
      else query.delete(key);
    }
    const suffix = query.toString();
    router.push(suffix ? `/suppressions?${suffix}` : "/suppressions", { scroll: false });
  }

  function setParam(key: string, value: string) {
    // Any change to what's shown starts at the first page.
    setParams(key === "page" ? { page: value } : { [key]: value, page: "" });
  }

  const narrowed = Boolean(search || filters.reason || filters.domain || filters.from || filters.to);
  const activeChips: FilterBarChip[] = [
    ...(search ? [{ key: "address", label: `Address like “${search}”` }] : []),
    ...(filters.from || filters.to
      ? [{ key: "dates", label: `Added ${filters.from ?? "…"} to ${filters.to ?? "today"}` }]
      : []),
  ];

  function clearAll() {
    setParams({ address: "", reason: "", domain: "", from: "", to: "", page: "" });
    heading.current?.focus();
  }

  const columns: DataTableColumn<SuppressionListItem>[] = [
    {
      key: "address",
      header: "Address",
      priority: "primary",
      cellClassName: "w-full max-w-0 sm:w-auto sm:max-w-none",
      cell: (row) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <CopyOnHover value={row.address} label="address" className="font-mono" hideOnTouch>
            {row.address}
          </CopyOnHover>
          <span className="truncate text-2xs text-muted-foreground sm:hidden">
            <Time date={row.createdAt} />
          </span>
        </span>
      ),
    },
    {
      key: "reason",
      header: "Reason",
      priority: "primary",
      cellClassName: "whitespace-nowrap",
      cell: (row) => <StatusDot tone={REASON_TONE[row.reason]}>{REASON_LABEL[row.reason]}</StatusDot>,
    },
    {
      key: "detail",
      header: "Detail",
      // The longest and least important text, so it takes the slack once the fold opens up.
      cellClassName: "sm:w-full sm:max-w-0",
      cell: (row) =>
        row.detail ? (
          <span className="line-clamp-1 font-mono text-2xs text-muted-foreground" title={row.detail}>
            {row.detail}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "source",
      header: "From",
      cellClassName: "whitespace-nowrap",
      cell: (row) =>
        row.source ? (
          <Link
            href={`/messages/${row.source.id}`}
            onClick={(event) => event.stopPropagation()}
            className="line-clamp-1 underline underline-offset-4"
            title={row.source.subject}
          >
            {row.source.subject}
          </Link>
        ) : row.importedFrom ? (
          <span className="line-clamp-1 text-foreground-soft" title={`Imported from ${row.importedFrom}`}>
            {row.importedFrom}
          </span>
        ) : (
          <span className="text-muted-foreground">{row.reason === "manual" ? "added by hand" : "message no longer on file"}</span>
        ),
    },
    {
      key: "added",
      header: "Added",
      numeric: true,
      cellClassName: "whitespace-nowrap",
      cell: (row) => <Time date={row.createdAt} />,
    },
    {
      key: "remove",
      header: <span className="sr-only">Remove</span>,
      numeric: true,
      cell: (row) =>
        canRemove ? (
          <IconButton
            icon="close"
            label={`Remove ${row.address}`}
            className={ROW_ACTION}
            onClick={(event) => {
              event.stopPropagation();
              opener.remember(event);
              setConfirming(row);
            }}
          />
        ) : (
          <IconButton
            icon="close"
            label="Your role doesn't let you remove a suppression."
            className={ROW_ACTION}
            disabled
            onClick={(event) => event.stopPropagation()}
          />
        ),
    },
  ];

  return (
    <>
      <PageHeader
        titleRef={heading}
        title="Suppressions"
        description="Sends to any of these addresses fail at the API until you remove them."
        meta={
          narrowed
            ? `${total} ${total === 1 ? "address matches" : "addresses match"}.`
            : `${total} ${total === 1 ? "address" : "addresses"}.`
        }
        actions={
          <>
            <Button size="md" onClick={() => setParam("state", "add")}>
              Add address
            </Button>
            <OverflowMenu
              actions={[
                { label: "Import CSV", onSelect: () => setParam("state", "import") },
                total > 0 && {
                  label: "Export CSV",
                  href: `/api/dashboard/suppressions/export${suppressionListQuery({ search, ...filters })}`,
                  download: true,
                },
              ]}
            />
          </>
        }
      />

      {summary.byReason.length > 0 ? <Summary summary={summary} /> : null}

      {panel === "add" ? <AddForm onDone={() => setParam("state", "")} /> : null}
      {panel === "import" ? <ImportPanel onDone={() => setParam("state", "")} /> : null}

      <FilterBar
        label="Suppression filters"
        className="pb-4"
        presets={
          <form
            role="search"
            className="flex w-full min-w-0 sm:w-auto sm:flex-1 sm:max-w-sm"
            onSubmit={(event) => {
              event.preventDefault();
              setParam("address", searchInput.current?.value.trim() ?? "");
            }}
          >
            <label htmlFor="suppression-search" className="sr-only">
              Search suppressed addresses
            </label>
            <input
              ref={searchInput}
              key={search}
              id="suppression-search"
              type="search"
              name="address"
              defaultValue={search}
              placeholder="Search addresses"
              className={`${fieldClasses({ shape: "pill", size: "sm" })} w-full font-mono`}
            />
          </form>
        }
        active={activeChips}
        onRemove={(key) => (key === "dates" ? setParams({ from: "", to: "", page: "" }) : setParam(key, ""))}
        onClearAll={clearAll}
        canClear={narrowed}
      >
        <Select
          items={REASON_OPTIONS}
          value={filters.reason ?? "all"}
          onValueChange={(next) => setParam("reason", next === "all" ? "" : next)}
          aria-label="Filter by reason"
          size="sm"
          shape="pill"
          triggerClassName="w-auto"
        />
        {domainNames.length > 0 ? (
          <Select
            items={[{ value: "all", label: "Any domain" }, ...domainNames.map((name) => ({ value: name, label: name }))]}
            value={filters.domain ?? "all"}
            onValueChange={(next) => setParam("domain", next === "all" ? "" : next)}
            aria-label="Filter by the domain that sent the message behind it"
            size="sm"
            shape="pill"
            triggerClassName="w-auto max-w-[14rem]"
          />
        ) : null}
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          From
          <input
            type="date"
            value={filters.from ?? ""}
            max={filters.to}
            onChange={(event) => setParam("from", event.target.value)}
            className={cn(fieldClasses({ shape: "pill", size: "sm" }), "w-auto")}
          />
        </label>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          To
          <input
            type="date"
            value={filters.to ?? ""}
            min={filters.from}
            onChange={(event) => setParam("to", event.target.value)}
            className={cn(fieldClasses({ shape: "pill", size: "sm" }), "w-auto")}
          />
        </label>
      </FilterBar>

      {results.searchDegraded ? <SearchDegradedNote /> : null}

      <Card className="overflow-hidden p-0">
        <DataTable
          label="Suppressed addresses"
          columns={columns}
          rows={rows}
          getRowKey={(row) => row.id}
          onRowClick={(row) => router.push(`/suppressions/${row.id}`)}
          empty={
            narrowed ? (
              <EmptyState
                icon="search"
                title="Nothing matches these filters"
                description={
                  search && !filters.reason && !filters.domain && !filters.from && !filters.to
                    ? `No suppressed address contains “${search}”, so sends to it go out.`
                    : "No suppression matches every filter above."
                }
                action={
                  <Button variant="secondary" size="md" onClick={clearAll}>
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon="block"
                title="Nothing is suppressed"
                description="An address lands here when it hard-bounces or complains. Add one by hand or import a CSV."
                action={
                  <Button size="md" onClick={() => setParam("state", "add")}>
                    Add address
                  </Button>
                }
              />
            )
          }
        />
      </Card>

      {pageCount > 1 ? (
        <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 pt-4">
          <p className="type-body-sm text-muted-foreground" aria-live="polite">
            {first}–{last} of {total}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={page <= 1}
              onClick={() => setParam("page", String(page - 1))}
            >
              Previous
            </Button>
            <span className="type-body-sm text-muted-foreground">
              Page {page} of {pageCount}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= pageCount}
              onClick={() => setParam("page", String(page + 1))}
            >
              Next
            </Button>
          </div>
        </nav>
      ) : null}

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        onCloseAutoFocus={opener.restore}
        title={confirming ? `Remove ${confirming.address}?` : ""}
        consequence={confirming ? removalConsequence(confirming.reason) : ""}
        confirmLabel="Remove address"
        tone="destructive"
        loading={remove.pending}
        onConfirm={() => {
          if (!confirming) return;
          const form = new FormData();
          form.set("address", confirming.address);
          remove.formAction(form);
          setConfirming(null);
        }}
        cancelLabel="Cancel"
      />
    </>
  );
}

function Summary({ summary }: { summary: SuppressionSummary }) {
  const added = summary.added.reduce((total, value) => total + value, 0);
  return (
    <Card className="mb-6 grid gap-x-10 gap-y-6 p-6 md:grid-cols-[3fr_2fr]">
      <div>
        <SectionHeader title="By reason" />
        <div className="mt-4">
          <RankedList
            items={summary.byReason.map((row) => ({
              key: row.reason,
              label: REASON_LABEL[row.reason],
              count: row.count,
              href: `/suppressions?reason=${row.reason}`,
            }))}
          />
        </div>
      </div>
      <div className="hidden md:block">
        <SectionHeader
          title="Added"
          meta={`${formatNumber(added)} in the last ${SUPPRESSION_TREND_DAYS} days.`}
        />
        {added > 0 ? (
          <Sparkline
            className="mt-4 h-12"
            values={summary.added}
            labels={summary.days.map((day) => day.slice(5))}
            label="Addresses added per day"
          />
        ) : null}
      </div>
    </Card>
  );
}

const inputClass = `${fieldClasses({ shape: "compact", size: "md" })} w-full font-mono`;

function AddForm({ onDone }: { onDone: () => void }) {
  // The error shows on the field, so only success is reported.
  const { state, formAction, pending } = useAction(addSuppressionAction, (next) => {
    if (next.status === "ok") {
      toast({ title: next.message, variant: "success" });
      onDone();
    }
  });
  const error = state.status === "error" ? state.message : undefined;

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onDone()}
      title="Add address"
      description="Sends to this address fail at the API until you remove it."
    >
      <form onSubmit={keepValues(formAction)} className="flex flex-col gap-5">
        <div className="flex flex-col gap-4">
          <Field
            id="suppression-address"
            label="Address"
            hint="The domain part is lowercased; the local part is kept as typed."
            error={error}
          >
            <input
              id="suppression-address"
              name="address"
              type="email"
              placeholder="name@example.com"
              className={inputClass}
              autoComplete="off"
              spellCheck={false}
              required
            />
          </Field>

          <Field id="suppression-note" label="Note" hint="Why it’s here. Shown in the Detail column.">
            <input
              id="suppression-note"
              name="note"
              type="text"
              placeholder="Asked to be removed by phone."
              className={`${fieldClasses({ shape: "compact", size: "md" })} w-full`}
              autoComplete="off"
            />
          </Field>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="md" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" size="md" disabled={pending}>
            {pending ? "Adding…" : "Suppress address"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
