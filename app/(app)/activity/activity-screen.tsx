"use client";

import { Fragment, useMemo, useRef } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filter-bar";
import { Icon } from "@/components/ui/icon";
import { MultiSelect } from "@/components/ui/multi-select";
import { filtersToQuery, hasActiveFilters, toggleFamily, toggleOutcome } from "@/lib/activity/filter";
import { isOrganizationWide } from "@/lib/activity/group";
import { actorInitials, actorName, detailsFor, OUTCOME_LABELS, OUTCOME_TONE } from "@/lib/activity/labels";
import { ALL_FAMILIES, FAMILY_LABELS } from "@/lib/activity/taxonomy";
import type {
  ActivityActorOption,
  ActivityCursor,
  ActivityDetailData,
  ActivityFacets,
  ActivityGroup,
  ActivityListItem,
  ActivityOutcome,
} from "@/lib/activity/types";
import { absoluteTime, clockTime, zonedTime } from "@/lib/format/time";
import { dayHeading, type DayCount } from "@/lib/dashboard/views/days";
import { activityEntriesByDay } from "@/lib/dashboard/views/activity-entries";
import { actionPhrase, subjectPhrase, type SubjectPhrase } from "@/lib/dashboard/views/activity-phrase";
import { cn } from "@/lib/utils";
import { adjacentKeys, useRowNavigation, type RowProps } from "@/hooks/use-row-navigation";
import { DayBars } from "../_ui/day-bars";
import { useHeaderOffset } from "../_ui/use-header-offset";
import { useTimeZone } from "../_ui/time-zone";
import { ZoneNote } from "../_ui/zone-note";
import { PageHeader } from "../_ui/page-header";
import { ActivityDetail } from "./activity-detail";
import { ACTOR_FILTER_HELP, FAMILY_HELP } from "./labels";
import type { ActivityQuery } from "./query";
import { formatNumber } from "@/lib/format/number";

const OUTCOME_CHIPS: ActivityOutcome[] = ["failure", "success"];

/** A non-human actor gets a glyph, never a fake person's initials. */
function actorGlyph(type: ActivityListItem["actor"]["type"]): "key" | "settings" | "flow" | "shield" | null {
  if (type === "admin") return "shield";
  if (type === "api_key") return "key";
  if (type === "worker") return "settings";
  if (type === "provider") return "flow";
  return null;
}

function ActorBadge({ actor }: { actor: ActivityListItem["actor"] }) {
  const glyph = actorGlyph(actor.type);
  return (
    <Avatar size="sm" fallback={actorInitials(actor) || "?"}>
      {glyph ? <Icon name={glyph} aria-hidden className="size-3.5 text-muted-foreground" /> : undefined}
    </Avatar>
  );
}

/** The subject renders as a link while the thing it names still exists, plain text once it's gone. */
function Subject({ id, label, href }: { id: string; label: string; href: string | null }) {
  if (!href) return <span className="font-medium">{label}</span>;
  return (
    <Link key={id} href={href} className="relative z-10 font-medium underline underline-offset-4 hover:no-underline">
      {label}
    </Link>
  );
}

function Subjects({ phrase }: { phrase: SubjectPhrase }) {
  const { parts, more } = phrase;
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={part.kind === "subject" ? part.subject.id : part.text}>
          {index > 0 && <span>{index === parts.length - 1 && more === 0 ? " and " : ", "}</span>}
          {part.kind === "subject" ? <Subject {...part.subject} /> : <span className="font-medium">{part.text}</span>}
        </Fragment>
      ))}
      {more > 0 && <span className="text-muted-foreground"> and {more} more</span>}
    </>
  );
}

function ActivitySentence({ group }: { group: ActivityGroup }) {
  const phrase = actionPhrase(group);
  const details = detailsFor(group);
  const wide = isOrganizationWide(group);
  const subjects = subjectPhrase(group);

  return (
    <span className="min-w-0 text-sm leading-relaxed">
      <span className="font-medium">{actorName(group.actor)}</span> <span>{phrase.text}</span>
      {!phrase.standalone && group.subjects.length > 0 ? (
        <>
          {" "}
          <Subjects phrase={subjects} />
        </>
      ) : null}
      {wide && group.subjects.length === 0 && group.family !== "session" ? <span className="text-muted-foreground"> across the organization</span> : null}
      {phrase.showCount ? <span className="text-muted-foreground"> ×{group.count}</span> : null}
      {details.length > 0 ? <span className="wrap-anywhere text-muted-foreground"> · {details.join(" · ")}</span> : null}
    </span>
  );
}

/** `14:32`, or `14:02–14:32` for a run. The day heading carries the date. */
function clockRange(group: ActivityGroup, zone: string): string {
  const last = clockTime(group.lastAt, zone).slice(0, 5);
  const first = clockTime(group.firstAt, zone).slice(0, 5);
  return first === last ? last : `${first}–${last}`;
}

/** The sticky app header's height, so day headings stick under it rather than behind it. */
function Entry({
  group,
  href,
  active,
  last,
  rowProps,
}: {
  group: ActivityGroup;
  href: string | null;
  active: boolean;
  last: boolean;
  /** The roving tab stop and arrow keys, on the entry's link. */
  rowProps?: RowProps;
}) {
  const zone = useTimeZone();
  const failed = group.outcome === "failure";
  return (
    <li
      className={cn(
        "relative flex items-start gap-3 rounded-lg px-2 py-2.5",
        href && "hover:bg-muted/50 has-[>a:focus-visible]:bg-accent",
        active && "bg-accent/60",
      )}
    >
      {href ? (
        <Link
          href={href}
          scroll={false}
          {...rowProps}
          aria-current={active ? "true" : undefined}
          className="absolute inset-0 rounded-lg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        >
          <span className="sr-only">Open details</span>
        </Link>
      ) : null}
      <span className="relative flex shrink-0 flex-col items-center self-stretch">
        <ActorBadge actor={group.actor} />
        {!last ? <span aria-hidden className="absolute top-9 -bottom-3.5 w-px bg-border" /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5 sm:flex-row sm:items-start sm:gap-3">
        <span className="min-w-0 flex-1">
          <ActivitySentence group={group} />
          {failed ? (
            <Chip tone={OUTCOME_TONE.failure} className="ml-2 align-middle">
              {OUTCOME_LABELS.failure}
            </Chip>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-2 text-2xs text-muted-foreground sm:pt-0.5">
          <span>{FAMILY_LABELS[group.family]}</span>
          <span aria-hidden>·</span>
          <time dateTime={group.lastAt.toISOString()} title={zonedTime(group.lastAt, zone)} className="font-mono tabular-nums">
            {clockRange(group, zone)}
          </time>
        </span>
      </span>
    </li>
  );
}

export function ActivityScreen({
  rows,
  nextCursor,
  query,
  facets,
  actorOptions,
  days,
  open,
}: {
  rows: ActivityListItem[];
  nextCursor: ActivityCursor | null;
  query: ActivityQuery;
  facets: ActivityFacets;
  actorOptions: ActivityActorOption[];
  /** Counts per day under the same filters, for the chart. */
  days: DayCount[];
  open?: ActivityDetailData;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const { filters } = query;
  const heading = useRef<HTMLHeadingElement>(null);

  const zone = useTimeZone();
  const byDay = useMemo(() => activityEntriesByDay(rows, zone), [rows, zone]);
  // Only single entries open a detail; a collapsed group has nothing to step to.
  const keys = byDay.flatMap(({ groups }) => groups.flatMap((group) => (group.single ? [group.single.id] : [])));
  const { getRowProps } = useRowNavigation({ keys, activeKey: open?.id });
  const { previous, next } = adjacentKeys(keys, open?.id);
  const headerOffset = useHeaderOffset();
  const now = new Date();
  const total = days.reduce((sum, day) => sum + day.total, 0);
  const failures = days.reduce((sum, day) => sum + day.flagged, 0);
  const suffix = params.toString() ? `?${params.toString()}` : "";

  function setParam(patch: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    // A filter change starts over at the newest row — an old cursor from a different
    // filter set points at a row the new query may not even return.
    next.delete("before");
    next.delete("beforeId");
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const search = next.toString();
    router.push(search ? `/activity?${search}` : "/activity", { scroll: false });
  }

  const hrefFor = (next: typeof filters) => {
    const query = filtersToQuery(next);
    return query ? `/activity?${query}` : "/activity";
  };

  const activeChips = [
    ...filters.families.map((family) => ({ key: `family:${family}`, label: FAMILY_LABELS[family] })),
    ...filters.outcomes.map((outcome) => ({ key: `outcome:${outcome}`, label: OUTCOME_LABELS[outcome] })),
    ...filters.actors.map((key) => {
      const option = actorOptions.find((candidate) => candidate.key === key);
      return { key: `actor:${key}`, label: option ? actorName(option.actor) : key };
    }),
  ];

  function removeChip(key: string) {
    if (key.startsWith("family:")) {
      const family = key.slice("family:".length);
      setParam({ family: filters.families.filter((f) => f !== family).join(",") || null });
    } else if (key.startsWith("outcome:")) {
      const outcome = key.slice("outcome:".length);
      setParam({ outcome: filters.outcomes.filter((o) => o !== outcome).join(",") || null });
    } else if (key.startsWith("actor:")) {
      const actor = key.slice("actor:".length);
      setParam({ actor: filters.actors.filter((a) => a !== actor).join(",") || null });
    }
  }

  function clearAll() {
    setParam({ family: null, outcome: null, actor: null });
    // The control that was clicked (the bar's "Clear all", the empty state's "Clear filters")
    // unmounts once filters clear.
    heading.current?.focus();
  }

  // Never a chip that can only ever produce an empty list, unless it's already selected — a
  // selected chip has to stay reachable to be turned back off.
  const familyChips = ALL_FAMILIES.filter((family) => facets.families.includes(family) || filters.families.includes(family));

  const genuinelyEmpty = rows.length === 0 && !query.narrowed && !query.paged;

  return (
    <>
      <PageHeader
        titleRef={heading}
        title="Activity"
        description="Who changed what and when. Delivery events live on each message."
        meta={`${formatNumber(total)} ${total === 1 ? "event" : "events"} ${
          filters.since ? `since ${absoluteTime(filters.since, zone)}` : `in the last ${days.length} days`
        }${failures > 0 ? `, ${formatNumber(failures)} failed` : ""}.`}
      />

      <FilterBar
        label="Activity filters"
        className="pb-4"
        active={activeChips}
        onRemove={removeChip}
        onClearAll={clearAll}
        canClear={hasActiveFilters(filters)}
      >
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by result">
          {OUTCOME_CHIPS.filter((outcome) => facets.outcomes[outcome] > 0 || filters.outcomes.includes(outcome)).map(
            (outcome) => (
              <Link
                key={outcome}
                href={hrefFor(toggleOutcome(filters, outcome))}
                scroll={false}
                aria-current={filters.outcomes.includes(outcome) ? "true" : undefined}
              >
                <Chip tone={filters.outcomes.includes(outcome) ? OUTCOME_TONE[outcome] : "neutral"}>
                  {OUTCOME_LABELS[outcome]} <span className="tabular-nums opacity-70">{facets.outcomes[outcome]}</span>
                </Chip>
              </Link>
            ),
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by category">
          {familyChips.map((family) => (
            <Link
              key={family}
              href={hrefFor(toggleFamily(filters, family))}
              scroll={false}
              title={FAMILY_HELP[family]}
              aria-current={filters.families.includes(family) ? "true" : undefined}
            >
              <Chip tone={filters.families.includes(family) ? "signal" : "neutral"}>{FAMILY_LABELS[family]}</Chip>
            </Link>
          ))}
        </div>

        <div className="min-w-44">
          <MultiSelect
            options={actorOptions.map((option) => ({ value: option.key, label: actorName(option.actor) }))}
            value={filters.actors}
            onValueChange={(value) => setParam({ actor: value.length > 0 ? value.join(",") : null })}
            placeholder="Anyone"
            aria-label={`Filter by actor. ${ACTOR_FILTER_HELP}`}
            shape="pill"
            size="sm"
          />
        </div>
      </FilterBar>

      {total > 0 ? (
        <section aria-label="Activity per day" className="mb-4">
          <DayBars
            days={days}
            unit={["event", "events"]}
            label={`${formatNumber(total)} events over ${days.length} days, ${formatNumber(failures)} failed.`}
          />
        </section>
      ) : null}

      {byDay.length === 0 ? (
        <div className="rounded-xl border border-border">
          {genuinelyEmpty ? (
            <EmptyState
              icon="clock"
              title="No activity yet"
              description="Key, domain, suppression, webhook and settings changes appear here, along with sign-ins and automatic actions."
            />
          ) : (
            <EmptyState
              icon="search"
              title="Nothing matches these filters"
              description="Widen the filters or clear them."
              action={
                <Button variant="secondary" size="md" onClick={clearAll}>
                  Clear filters
                </Button>
              }
            />
          )}
        </div>
      ) : (
        <div className="flex flex-col">
          {byDay.map(({ day, groups }, index) => (
            <section key={day} aria-labelledby={`day-${day}`}>
              <h2
                id={`day-${day}`}
                style={{ top: headerOffset }}
                className="sticky z-20 -mx-2 bg-background/90 px-2 py-2 text-xs font-medium text-muted-foreground backdrop-blur"
              >
                <span className="flex items-center justify-between gap-3">
                  <time dateTime={day}>{dayHeading(day, zone, now)}</time>
                  {index === 0 ? <ZoneNote /> : null}
                </span>
              </h2>
              <ol className="mb-3 flex flex-col">
                {groups.map((group, index) => (
                  <Entry
                    key={group.id}
                    group={group}
                    href={group.single ? `/activity/${group.single.id}${suffix}` : null}
                    active={open?.id === group.single?.id && open !== undefined}
                    last={index === groups.length - 1}
                    rowProps={group.single ? getRowProps(group.single.id) : undefined}
                  />
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}

      {(query.paged || nextCursor) && (
        <div className="mt-4 flex items-center justify-between text-sm">
          {query.paged ? (
            <Button variant="ghost" size="sm" onClick={() => setParam({ before: null, beforeId: null })}>
              Newest
            </Button>
          ) : (
            <span />
          )}
          {nextCursor ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setParam({ before: nextCursor.createdAt.toISOString(), beforeId: nextCursor.id })}
            >
              Older
            </Button>
          ) : null}
        </div>
      )}

      {open ? (
        <ActivityDetail
          item={open}
          onClose={() => router.push(`/activity${suffix}`, { scroll: false })}
          onPrevious={previous ? () => router.push(`/activity/${previous}${suffix}`, { scroll: false }) : undefined}
          onNext={next ? () => router.push(`/activity/${next}${suffix}`, { scroll: false }) : undefined}
        />
      ) : null}
    </>
  );
}
