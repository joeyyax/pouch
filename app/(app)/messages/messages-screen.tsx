"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { fieldClasses } from "@/components/ui/field";
import { FilterBar } from "@/components/ui/filter-bar";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { Icon } from "@/components/ui/icon";
import { MultiSelect } from "@/components/ui/multi-select";
import { Select } from "@/components/ui/select";
import { MESSAGE_STATUSES } from "@/lib/db/enums";
import { adjacentKeys } from "@/hooks/use-row-navigation";
import { shortcutKey } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import { LIST_WINDOW_DAYS } from "@/lib/dashboard/views/messages";
import type { MessageDetailData, MessageListItem } from "@/lib/dashboard/views/messages";
import type { KeyFilterOption } from "@/lib/dashboard/views/keys";
import type { DayCount } from "@/lib/dashboard/views/days";
import { Chip } from "@/components/ui/chip";
import { durationLabel } from "@/lib/format/time";
import { StatusChip, SuppressedMarker } from "../_ui/status";
import { Term } from "../_ui/term";
import { CopyOnHover } from "../_ui/copy-on-hover";
import { Time } from "../_ui/time";
import { PageHeader } from "../_ui/page-header";
import { SearchDegradedNote } from "../_ui/search-degraded-note";
import { SegmentedLinks } from "../_ui/segmented-links";
import type { SnippetLanguage } from "@/lib/dashboard/curl";
import { Snippet } from "../_ui/snippet";
import { DayBars } from "../_ui/day-bars";
import { DayTable } from "./day-table";
import { MessageDetail } from "./message-detail";
import { LiveIndicator } from "./live-indicator";
import { useLiveUpdates } from "./use-live-updates";
import { ExportMenu } from "./export-menu";
import type { MessagesQuery } from "@/lib/messages/query";
import { formatNumber } from "@/lib/format/number";

const STATUS_OPTIONS = MESSAGE_STATUSES.map((status) => ({ value: status, label: status }));

const columns: DataTableColumn<MessageListItem>[] = [
  {
    key: "status",
    header: "Status",
    priority: "primary",
    cell: (row) => (
      <StatusChip
        shape="dot"
        status={row.status}
        stuck={row.stuck}
        explain={
          row.stuck
            ? `Queued for ${durationLabel(row.createdAt)} and not yet handed to the provider.`
            : row.status === "delivered"
              ? undefined
              : true
        }
        announce
      />
    ),
  },
  {
    key: "to",
    header: "To",
    priority: "primary",
    // A real address is longer than the fixtures' were, at every width: max-w-0 on a
    // full-width cell is what lets it truncate instead of pushing the table into an
    // unmarked horizontal scroll. Capped rather than unbounded above sm so the subject,
    // domain and time keep their room.
    cellClassName: "w-full max-w-0 sm:w-auto sm:max-w-[22ch] lg:max-w-[34ch]",
    cell: (row) => (
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <CopyOnHover value={row.to} label="address" className="font-mono" hideOnTouch>
            {row.to}
          </CopyOnHover>
          {row.recipientCount > 1 ? (
            <span className="shrink-0 text-2xs text-muted-foreground">
              +{row.recipientCount - 1} more
            </span>
          ) : null}
          {row.suppressed ? <SuppressedMarker address={row.to} /> : null}
          {row.testMode ? (
            <Term chip term="test">
              <Chip tone="signal">test</Chip>
            </Term>
          ) : null}
        </span>
        {/* The folded columns, restated where the fold leaves room. */}
        <span className="truncate text-2xs text-muted-foreground sm:hidden">
          {row.sensitive ? <Icon name="eye-off" label="Sensitive" className="mr-1 inline size-3 align-[-2px]" /> : null}
          {row.subject} · {row.keyName ? `${row.keyName} · ` : ""}<Time date={row.createdAt} />
        </span>
      </span>
    ),
  },
  {
    key: "subject",
    header: "Subject",
    cellClassName: "sm:w-full sm:max-w-0",
    cell: (row) => (
      <span className="flex min-w-0 items-center gap-1.5">
        {row.sensitive ? (
          <Term chip term="sensitive" className="inline-flex shrink-0 text-muted-foreground">
            <Icon name="eye-off" label="Sensitive" className="size-3.5" />
          </Term>
        ) : null}
        <span className="line-clamp-1">{row.subject}</span>
      </span>
    ),
  },
  {
    key: "domain",
    header: "Domain",
    cellClassName: "whitespace-nowrap",
    cell: (row) => <span className="font-mono text-muted-foreground">{row.domainName}</span>,
  },
  {
    key: "key",
    header: "Key",
    cellClassName: "whitespace-nowrap max-w-[20ch]",
    cell: (row) =>
      row.keyId && row.keyName ? (
        <CopyOnHover value={row.keyName} label="key name" className="font-mono">
          <Link
            href={`/keys/${row.keyId}`}
            onClick={(event) => event.stopPropagation()}
            className="text-muted-foreground underline underline-offset-4 hover:text-foreground"
            title={row.keyName}
          >
            {row.keyName}
          </Link>
        </CopyOnHover>
      ) : (
        <span className="text-muted-foreground">No key</span>
      ),
  },
  {
    key: "time",
    header: "Time",
    numeric: true,
    cellClassName: "whitespace-nowrap",
    cell: (row) => <Time date={row.createdAt} />,
  },
];

export function MessagesScreen({
  rows,
  volume,
  offset = 0,
  hasOlder = false,
  failed,
  query,
  firstSend,
  tagOptions,
  domainNames,
  keyOptions,
  open,
  searchDegraded = false,
}: {
  rows: MessageListItem[];
  /** Messages per day across the whole window, under the same filters as the rows. */
  volume: DayCount[];
  /** Messages newer than this page's first row, under the same filters. */
  offset?: number;
  hasOlder?: boolean;
  /** The list query itself failed. The chrome and the filters still work. */
  failed: boolean;
  query: MessagesQuery;
  /** The curl the empty state offers, or null when no verified domain exists yet. */
  firstSend: SnippetLanguage[] | null;
  /** Tags in use within the current scope, for the tag filter's picker. */
  tagOptions: string[];
  /** Every domain the organization holds, for the scope filter. */
  domainNames: string[];
  /** Every organization key, for the key filter. */
  keyOptions: KeyFilterOption[];
  open?: MessageDetailData;
  /** The typo-tolerant index didn't answer this search. */
  searchDegraded?: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  // A message changing status while you watch is the point of this screen.
  const live = useLiveUpdates();
  const heading = useRef<HTMLHeadingElement>(null);
  const search = useRef<HTMLInputElement>(null);

  // `/` focuses search from anywhere that isn't already a text field.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (shortcutKey(event) !== "/") return;
      event.preventDefault();
      search.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const suffix = params.toString() ? `?${params.toString()}` : "";
  // The URL follows a step, so back and forward retrace it.
  const { previous, next } = adjacentKeys(rows.map((row) => row.id), open?.id);
  const openMessage = (id: string) => router.push(`/messages/${id}${suffix}`, { scroll: false });

  const domainOptions = [{ value: "all", label: "All domains" }, ...domainNames.map((name) => ({ value: name, label: name }))];
  const chosenKey = keyOptions.find((option) => option.id === query.keyId);
  const keySelectOptions = [
    { value: "all", label: "All keys" },
    ...keyOptions.map((option) => ({ value: option.id, label: option.revoked ? `${option.name} (revoked)` : option.name })),
    // A key id the URL names but the organization doesn't hold still reads as chosen.
    ...(query.keyId && !chosenKey ? [{ value: query.keyId, label: query.keyId }] : []),
  ];

  /** Writes one filter into the URL. The URL is the state. A filter change starts at the newest page. */
  function setParam(patch: Record<string, string | null>, paging = false) {
    const next = new URLSearchParams(params);
    if (!paging) {
      next.delete("before");
      next.delete("after");
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const search = next.toString();
    router.push(search ? `/messages?${search}` : "/messages", { scroll: paging });
  }

  /** A view keeps the other filters and drops the status pick it replaces. */
  function presetHref(preset: "attention" | "held" | null) {
    const next = new URLSearchParams(params);
    next.delete("status");
    next.delete("before");
    next.delete("after");
    if (preset) next.set("preset", preset);
    else next.delete("preset");
    const search = next.toString();
    return search ? `/messages?${search}` : "/messages";
  }

  // Pickers and the view switch show their own values. This row carries the rest.
  const activeChips = [
    ...(query.retried ? [{ key: "retried", label: "Retried" }] : []),
    ...(query.reason
      ? [{ key: "reason", label: `Reason: ${query.reason.length > 40 ? `${query.reason.slice(0, 39)}…` : query.reason}` }]
      : []),
    ...(query.days !== LIST_WINDOW_DAYS ? [{ key: "days", label: `Last ${spellDays(query.days)}` }] : []),
    ...(query.address ? [{ key: "address", label: `to ${query.address}` }] : []),
  ];

  function removeChip(key: string) {
    if (key === "retried") return setParam({ retried: null });
    if (key === "reason") return setParam({ reason: null });
    if (key === "days") return setParam({ days: null });
    setParam({ address: null });
  }

  function clearAll() {
    setParam({
      preset: null,
      status: null,
      tag: null,
      address: null,
      q: null,
      domain: null,
      key: null,
      retried: null,
      sensitive: null,
      reason: null,
      days: null,
    });
    // The control that was clicked (the bar's "Clear all", the empty state's "Clear filters")
    // unmounts once filters clear — same landing spot as MessageDetail closing onto no row.
    heading.current?.focus();
  }

  /** A tag chip on the open message filters the list to it. */
  function filterByTag(tag: string) {
    const next = query.tags.includes(tag) ? query.tags : [...query.tags, tag];
    setParam({ tag: next.join(",") });
  }

  const total = volume.reduce((sum, day) => sum + day.total, 0);
  const flagged = volume.reduce((sum, day) => sum + day.flagged, 0);
  const paged = offset > 0 || hasOlder;
  const countLine = paged
    ? `${formatNumber(offset + 1)}–${formatNumber(offset + rows.length)} of ${formatNumber(Math.max(total, offset + rows.length))} messages`
    : `${formatNumber(rows.length)} ${rows.length === 1 ? "message" : "messages"}`;

  const scopeLine = `${query.scope === "all" ? " across every domain" : ` on ${query.scope}`}${query.keyId ? ` sent with ${chosenKey?.name ?? "this key"}` : ""}`;

  return (
    <>
      <PageHeader
        titleRef={heading}
        title="Messages"
        description="Every send and what happened to it, in the provider’s words."
        meta={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              {failed
                ? "The list couldn’t be loaded."
                : `${countLine}${scopeLine}, last ${spellDays(query.days)}.`}
            </span>
            <LiveIndicator state={live} />
          </span>
        }
        actions={<ExportMenu />}
      />

      <div className="flex flex-col gap-2 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <form
            role="search"
            className="flex w-full sm:w-auto sm:flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              setParam({ q: search.current?.value.trim() || null });
            }}
          >
            <input
              ref={search}
              key={query.search ?? ""}
              type="search"
              name="q"
              defaultValue={query.search ?? ""}
              placeholder="Search id, address, subject"
              aria-label="Search messages, addresses and domains"
              className={cn(fieldClasses({ shape: "pill", size: "sm" }), "w-full")}
            />
          </form>
          <SegmentedLinks
            label="View"
            options={[
              { href: presetHref(null), label: "All", active: !query.preset && !query.heldPreset },
              { href: presetHref("attention"), label: "Needs attention", active: query.preset },
              { href: presetHref("held"), label: "Held", active: query.heldPreset },
            ]}
          />
        </div>

        <FilterBar
          label="Message filters"
          active={activeChips}
          onRemove={removeChip}
          onClearAll={clearAll}
          canClear={query.narrowed}
        >
          <div className="grid w-full grid-cols-1 items-start gap-2 sm:flex sm:w-auto">
            <div className="min-w-0 sm:w-56">
              <Select
                items={domainOptions}
                value={query.scope === "all" ? "all" : query.scope}
                onValueChange={(next) => setParam({ domain: next === "all" ? null : next })}
                aria-label="Domain scope"
                size="sm"
                shape="pill"
                triggerClassName="w-full whitespace-nowrap [&>span]:min-w-0 [&>span]:truncate"
              />
            </div>
            {keySelectOptions.length > 1 ? (
              <div className="min-w-0 sm:w-48">
                <Select
                  items={keySelectOptions}
                  value={query.keyId || "all"}
                  onValueChange={(next) => setParam({ key: next === "all" ? null : next })}
                  aria-label="Key"
                  size="sm"
                  shape="pill"
                  triggerClassName="w-full whitespace-nowrap [&>span]:min-w-0 [&>span]:truncate"
                />
              </div>
            ) : null}
            <div className="min-w-0 sm:w-auto sm:min-w-56">
              <MultiSelect
                options={STATUS_OPTIONS}
                value={query.preset ? [] : query.statuses}
                onValueChange={(value) =>
                  setParam({ status: value.length > 0 ? value.join(",") : null, preset: null })
                }
                placeholder="Any status"
                aria-label="Filter by status"
                shape="pill"
                size="sm"
              />
            </div>
            <div className="min-w-0 sm:w-auto sm:min-w-56">
              <MultiSelect
                options={tagOptions.map((tag) => ({ value: tag, label: tag }))}
                value={query.tags}
                onValueChange={(value) => setParam({ tag: value.length > 0 ? value.join(",") : null })}
                placeholder="Any tag"
                aria-label="Filter by tag"
                shape="pill"
                size="sm"
              />
            </div>
            <button
              type="button"
              aria-pressed={query.sensitive}
              onClick={() => setParam({ sensitive: query.sensitive ? null : "1" })}
              className={cn(
                fieldClasses({ shape: "pill", size: "sm" }),
                "press inline-flex w-auto items-center gap-1.5 whitespace-nowrap",
                FOCUS_RING,
                query.sensitive ? "border-foreground/40 text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon name="eye-off" className="size-4 shrink-0" />
              Sensitive
            </button>
          </div>
        </FilterBar>
      </div>

      {searchDegraded ? <SearchDegradedNote /> : null}

      <Card className="overflow-clip p-0">
        {total > 0 ? (
          <div className="flex flex-col gap-2 border-b border-border px-3 pt-3 pb-2">
            <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              Messages per day
              {flagged > 0 ? (
                <>
                  <span aria-hidden>·</span>
                  <span aria-hidden className="size-1.5 rounded-full bg-danger" />
                  {formatNumber(flagged)} bounced, complained or failed
                </>
              ) : null}
            </p>
            <DayBars
              days={volume}
              unit={["message", "messages"]}
              label={`${formatNumber(total)} messages over ${spellDays(volume.length)}, ${formatNumber(flagged)} bounced, complained or failed.`}
            />
          </div>
        ) : null}
        <DayTable
          label="Messages"
          columns={columns}
          rows={rows}
          getRowKey={(row) => row.id}
          getDate={(row) => row.createdAt}
          activeKey={open?.id}
          onRowClick={(row) => openMessage(row.id)}
          empty={
            query.narrowed ? (
              <EmptyState
                icon="search"
                title={
                  query.search
                    ? `Nothing matches “${query.search}”`
                    : `No ${query.preset ? "messages needing attention" : query.heldPreset ? "held messages" : "messages"} on ${query.scope === "all" ? "any domain" : query.scope} in the last ${spellDays(query.days)}`
                }
                description={query.search
                    ? `Search matches ids, addresses and subjects from the last ${spellDays(query.days)}.`
                    : "Widen the range or clear the filters."}
                action={
                  <Button variant="secondary" size="md" onClick={clearAll}>
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon="mail"
                title="No messages yet"
                description={
                  firstSend
                    ? "Send one with your API key and it shows up here."
                    : "Verify a domain and create a key, then send one and it shows up here."
                }
              >
                {firstSend ? <Snippet languages={firstSend} /> : null}
              </EmptyState>
            )
          }
          error={
            failed ? (
              <EmptyState
                icon="warning"
                title="Couldn’t load messages"
                description="The database didn’t answer. Nothing was lost — try again."
                action={
                  <Button size="md" onClick={() => router.refresh()}>
                    Retry
                  </Button>
                }
              />
            ) : undefined
          }
        />
      </Card>

      {paged && !failed ? (
        <div className="mt-4 flex items-center justify-between text-sm">
          {offset > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setParam({ after: rows[0]?.id ?? null, before: null }, true)}>
              Newer
            </Button>
          ) : (
            <span />
          )}
          {hasOlder ? (
            <Button variant="ghost" size="sm" onClick={() => setParam({ before: rows.at(-1)?.id ?? null, after: null }, true)}>
              Older
            </Button>
          ) : null}
        </div>
      ) : null}

      {open ? (
        <MessageDetail
          key={open.id}
          message={open}
          onClose={() => router.push(`/messages${suffix}`, { scroll: false })}
          onPrevious={previous ? () => openMessage(previous) : undefined}
          onNext={next ? () => openMessage(next) : undefined}
          onSelectTag={filterByTag}
          fallbackFocus={heading}
        />
      ) : null}
    </>
  );
}

function spellDays(days: number): string {
  return days === 1 ? "day" : `${days} days`;
}
