"use client";

import Link from "next/link";
import { useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { fieldClasses } from "@/components/ui/field";
import type { RecipientListItem, RecipientOutcomes, RecipientPage } from "@/lib/lists/recipients";
import { cn } from "@/lib/utils";
import { PageHeader } from "../_ui/page-header";
import { SearchDegradedNote } from "../_ui/search-degraded-note";
import { Time } from "../_ui/time";
import { StatusChip, SuppressedMarker } from "../_ui/status";
import { Term } from "../_ui/term";
import type { MessageStatus } from "@/lib/db/schema/messages";
import { formatNumber } from "@/lib/format/number";

const SEGMENTS: { key: keyof RecipientOutcomes; label: string; color: string }[] = [
  { key: "delivered", label: "delivered", color: "var(--success)" },
  { key: "bounced", label: "bounced", color: "var(--danger)" },
  { key: "complained", label: "complained", color: "var(--warning)" },
  { key: "failed", label: "failed", color: "var(--danger-soft)" },
];

/** Each outcome's share of the messages sent. The unfilled rest is in flight. */
function OutcomeBar({ row }: { row: RecipientListItem }) {
  const summary = SEGMENTS.filter((segment) => row.outcomes[segment.key] > 0)
    .map((segment) => `${row.outcomes[segment.key]} ${segment.label}`)
    .join(", ");
  return (
    <div role="img" aria-label={summary || "None resolved yet"} title={summary || "None resolved yet"} className="flex h-1.5 w-24 overflow-hidden rounded-full bg-muted">
      {SEGMENTS.map((segment) => (
        <span key={segment.key} style={{ width: `${(row.outcomes[segment.key] / row.messageCount) * 100}%`, backgroundColor: segment.color }} />
      ))}
    </div>
  );
}

/** Zero recedes; anything else is a problem worth seeing. */
function ProblemCount({ value }: { value: number }) {
  return <span className={cn("tabular-nums", value === 0 ? "text-muted-foreground" : "font-medium text-warning")}>{formatNumber(value)}</span>;
}

const COLUMNS: DataTableColumn<RecipientListItem>[] = [
  {
    key: "address",
    header: "Address",
    priority: "primary",
    cellClassName: "w-full max-w-0",
    cell: (row) => (
      <span className="block min-w-0">
        <Link
          href={`/messages?address=${encodeURIComponent(row.address)}`}
          className="block truncate font-mono underline underline-offset-4 hover:no-underline"
          title={`${row.address}: message history`}
        >
          {row.address}
        </Link>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
          {row.suppressed ? <SuppressedMarker address={row.address} /> : null}
          {row.unsubscribed ? <Chip tone="issue">unsubscribed</Chip> : null}
          <span className="truncate text-2xs text-muted-foreground">
            {/* The folded count, restated where the fold leaves room. */}
            <span className="sm:hidden">
              {formatNumber(row.messageCount)} {row.messageCount === 1 ? "message" : "messages"} ·{" "}
            </span>
            {row.domains.join(", ")}
          </span>
        </span>
      </span>
    ),
  },
  {
    key: "messages",
    header: "Messages",
    numeric: true,
    priority: "detail",
    cell: (row) => <span className="tabular-nums">{formatNumber(row.messageCount)}</span>,
  },
  { key: "outcomes", header: "Outcomes", priority: "detail", cell: (row) => <OutcomeBar row={row} /> },
  { key: "bounced", header: "Bounced", numeric: true, priority: "detail", cell: (row) => <ProblemCount value={row.outcomes.bounced} /> },
  { key: "complained", header: <Term term="complained">Complained</Term>, numeric: true, priority: "detail", cell: (row) => <ProblemCount value={row.outcomes.complained} /> },
  { key: "failed", header: <Term term="failed">Failed</Term>, numeric: true, priority: "detail", cell: (row) => <ProblemCount value={row.outcomes.failed} /> },
  { key: "status", header: "Status", priority: "detail", cell: (row) => <StatusChip shape="dot" status={row.lastStatus as MessageStatus} /> },
  {
    key: "last",
    header: "Last send",
    numeric: true,
    priority: "primary",
    cellClassName: "whitespace-nowrap",
    cell: (row) => <Time date={row.lastSentAt} />,
  },
];

export function RecipientsScreen({ results, search }: { results: RecipientPage; search: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const input = useRef<HTMLInputElement>(null);
  const { rows, total, page, pageCount } = results;

  function setParam(key: string, value: string) {
    const query = new URLSearchParams(params);
    if (value) query.set(key, value);
    else query.delete(key);
    if (key !== "page") query.delete("page");
    const suffix = query.toString();
    router.push(suffix ? `/recipients?${suffix}` : "/recipients", { scroll: false });
  }

  return (
    <>
      <PageHeader
        title="Recipients"
        description="Every address your domains have sent to."
        meta={`${formatNumber(total)} ${total === 1 ? "address" : "addresses"}${search ? ` matching “${search}”` : ""}.`}
      />

      <form
        role="search"
        className="flex min-w-0 max-w-sm pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          setParam("address", input.current?.value.trim() ?? "");
        }}
      >
        <label htmlFor="recipient-search" className="sr-only">
          Search recipients
        </label>
        <input
          ref={input}
          key={search}
          id="recipient-search"
          type="search"
          defaultValue={search}
          placeholder="Search addresses"
          className={`${fieldClasses({ shape: "pill", size: "sm" })} w-full font-mono`}
        />
      </form>

      {results.searchDegraded ? <SearchDegradedNote /> : null}

      {rows.length === 0 ? (
        search ? (
          <EmptyState
            icon="search"
            title="No matching addresses"
            description={`Nothing sent to an address like “${search}”.`}
            action={
              <Button variant="secondary" size="md" onClick={() => setParam("address", "")}>
                Clear search
              </Button>
            }
          />
        ) : (
          <EmptyState icon="mail" title="No recipients yet" description="An address shows up here once a message has been sent to it." />
        )
      ) : (
        <Card className="overflow-hidden p-0">
          <DataTable columns={COLUMNS} rows={rows} getRowKey={(row) => row.address} label="Recipients" />
        </Card>
      )}

      {pageCount > 1 ? (
        <nav aria-label="Pagination" className="flex items-center justify-between gap-3 pt-4">
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setParam("page", String(page - 1))}>
            Previous
          </Button>
          <span className="type-body-sm text-muted-foreground">
            Page {page} of {pageCount}
          </span>
          <Button variant="secondary" size="sm" disabled={page >= pageCount} onClick={() => setParam("page", String(page + 1))}>
            Next
          </Button>
        </nav>
      ) : null}
    </>
  );
}
