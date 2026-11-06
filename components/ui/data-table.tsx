"use client";

import type { CSSProperties, ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { useRowNavigation } from "@/hooks/use-row-navigation";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type SortDirection = "asc" | "desc";
export interface DataTableSort {
  key: string;
  direction: SortDirection;
}

export interface DataTableColumn<Row> {
  key: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  /** Right-aligns and sets tabular figures — every numeric column should. */
  numeric?: boolean;
  sortable?: boolean;
  /**
   * The mobile fold. `primary` columns stay visible under `sm`; `detail`
   * columns hide. Leave every column unset and the first and last survive,
   * which is the fold the dashboard wants: the thing and its status.
   */
  priority?: "primary" | "detail";
  headerClassName?: string;
  cellClassName?: string;
}

// DataTable — Table's dense, app-shaped sibling: sticky header, sortable
// columns, tabular figures, skeleton rows, and a mobile fold that drops
// everything but the columns that identify the row. It composes table.tsx's
// parts rather than restyling them, so a plain content table and a dense
// data table still read as the same family. Sorting and row selection are
// state the caller owns; this renders what it is handed.
export function DataTable<Row>({
  columns,
  rows,
  getRowKey,
  label,
  caption,
  dense = true,
  stickyHeader = false,
  maxHeight,
  sort,
  onSortChange,
  onRowClick,
  activeKey,
  rowClassName,
  loading = false,
  skeletonRows = 6,
  loadingLabel = "Loading rows",
  empty,
  error,
  headerClassName,
  className,
}: {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  getRowKey: (row: Row) => string;
  /** Names the scroll region. Say what the table is about. */
  label: string;
  caption?: ReactNode;
  /** Off drops back to Table's roomier row height. */
  dense?: boolean;
  /** Needs `maxHeight` to do anything — the header sticks to this table's own
   * scroll box, not the page, because the horizontal scroll container that
   * makes a wide table reachable is also a vertical one. */
  stickyHeader?: boolean;
  maxHeight?: CSSProperties["maxHeight"];
  sort?: DataTableSort;
  onSortChange?: (sort: DataTableSort) => void;
  /** Makes the rows a grid: one tab stop, Up/Down/Home/End between rows, Left/Right through a
   * row's links and buttons, Enter or Space opens. */
  onRowClick?: (row: Row) => void;
  /** The row whose detail is open. */
  activeKey?: string;
  /** Per-row classes, such as the dim on an inactive row. */
  rowClassName?: (row: Row) => string | undefined;
  loading?: boolean;
  skeletonRows?: number;
  loadingLabel?: string;
  /** Rendered in place of the rows when there are none. Compose an EmptyState. */
  empty?: ReactNode;
  /** Rendered in place of the rows when the fetch failed. Wins over `empty`. */
  error?: ReactNode;
  /** The sticky header's own fill. Defaults to the page ground — pass
   * `bg-card` when the table sits on a card. */
  headerClassName?: string;
  className?: string;
}) {
  // No column declared a priority, so keep the two that identify a row.
  const anyPriority = columns.some((c) => c.priority);
  const isFolded = (i: number) =>
    anyPriority ? columns[i]?.priority !== "primary" : i !== 0 && i !== columns.length - 1;

  const cellPad = dense ? "px-3 py-2" : "px-4 py-3";
  const state = error ? "error" : rows.length === 0 && !loading ? "empty" : "rows";
  const navigable = Boolean(onRowClick) && !loading && state === "rows";
  const byKey = new Map(rows.map((row) => [getRowKey(row), row]));
  const { getRowProps } = useRowNavigation({
    keys: navigable ? [...byKey.keys()] : [],
    activeKey,
    onOpen: (key) => {
      const row = byKey.get(key);
      if (row) onRowClick?.(row);
    },
  });

  return (
    <div
      // Rows take focus when navigable, which keeps the scroll box reachable without a stop of its own.
      tabIndex={navigable ? undefined : 0}
      role="region"
      aria-label={label}
      aria-busy={loading || undefined}
      style={maxHeight ? { maxHeight } : undefined}
      className={cn(
        // Inset, not outset: this table usually sits in a Card, and a Card
        // clips its overflow — an outline drawn outside is a ring nobody sees.
        "w-full overflow-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        className,
      )}
    >
      {loading ? (
        <span role="status" className="sr-only">
          {loadingLabel}
        </span>
      ) : null}
      <table
        role={navigable ? "grid" : undefined}
        aria-label={navigable ? label : undefined}
        className={cn("w-full border-collapse text-left", dense ? "text-sm" : "text-15")}
      >
        {caption ? <caption className="type-kicker pb-3 text-left text-tertiary">{caption}</caption> : null}
        <TableHead>
          <TableRow className="hover:bg-transparent">
            {columns.map((column, i) => (
              <TableHeaderCell
                key={column.key}
                scope="col"
                aria-sort={
                  column.sortable
                    ? sort?.key === column.key
                      ? sort.direction === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                    : undefined
                }
                className={cn(
                  cellPad,
                  column.sortable && "p-0",
                  column.numeric && "text-right",
                  stickyHeader && cn("sticky top-0 z-10", headerClassName ?? "bg-background"),
                  isFolded(i) && "hidden sm:table-cell",
                  column.headerClassName,
                )}
              >
                {column.sortable ? (
                  <SortButton
                    active={sort?.key === column.key}
                    direction={sort?.key === column.key ? sort.direction : undefined}
                    numeric={column.numeric}
                    className={cellPad}
                    onClick={() =>
                      onSortChange?.({
                        key: column.key,
                        direction: sort?.key === column.key && sort.direction === "asc" ? "desc" : "asc",
                      })
                    }
                  >
                    {column.header}
                  </SortButton>
                ) : (
                  column.header
                )}
              </TableHeaderCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {loading
            ? Array.from({ length: skeletonRows }, (_, r) => (
                <TableRow key={`skeleton-${r}`} className="hover:bg-transparent">
                  {columns.map((column, i) => (
                    <TableCell key={column.key} className={cn(cellPad, isFolded(i) && "hidden sm:table-cell")}>
                      <Skeleton className="h-3.5 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            : null}

          {!loading && state === "rows"
            ? rows.map((row) => {
                const key = getRowKey(row);
                return (
                  <TableRow
                    key={key}
                    // data-row-key lets a panel this row opened hand focus back to it after a re-render.
                    {...(navigable ? getRowProps(key) : { "data-row-key": key })}
                    aria-current={activeKey === key ? "true" : undefined}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={cn(
                      // A fill, not just an outline: Chrome paints no outline
                      // on a <tr> under border-collapse, so the ring alone
                      // leaves a focused row looking exactly like every other.
                      onRowClick &&
                        "cursor-pointer scroll-my-10 focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                      activeKey === key && "bg-accent/60",
                      rowClassName?.(row),
                    )}
                  >
                    {columns.map((column, i) => (
                      <TableCell
                        key={column.key}
                        className={cn(
                          cellPad,
                          column.numeric && "text-right font-mono tabular-nums",
                          isFolded(i) && "hidden sm:table-cell",
                          column.cellClassName,
                        )}
                      >
                        {column.cell(row)}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })
            : null}

          {!loading && state !== "rows" ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columns.length} className="p-0">
                {state === "error" ? error : empty}
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </table>
    </div>
  );
}

function SortButton({
  active,
  direction,
  numeric,
  className,
  onClick,
  children,
}: {
  active: boolean;
  direction?: SortDirection;
  numeric?: boolean;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // No `outline-none` here: it sets --tw-outline-style to none, which
        // the focus-visible width utility then inherits — a ring declared and
        // never drawn.
        "flex w-full items-center gap-1 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        numeric ? "justify-end" : "justify-start",
        active && "text-foreground",
        className,
      )}
    >
      {children}
      {/* The arrow is decoration — aria-sort on the cell is what a screen
          reader reads, so an unsorted column shows nothing rather than a
          neutral glyph nobody can act on. */}
      {active ? (
        <Icon
          name="chevron"
          strokeWidth={2.5}
          aria-hidden
          className={cn("size-3.5 shrink-0", direction === "asc" && "rotate-180")}
        />
      ) : null}
    </button>
  );
}
