"use client";

import type { ReactNode } from "react";
import type { DataTableColumn } from "@/components/ui/data-table";
import { TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "@/components/ui/table";
import { useRowNavigation } from "@/hooks/use-row-navigation";
import { dayHeading, groupByDay } from "@/lib/dashboard/views/days";
import { cn } from "@/lib/utils";
import { ZoneNote } from "../_ui/zone-note";
import { useHeaderOffset } from "../_ui/use-header-offset";
import { useTimeZone } from "../_ui/time-zone";

/** DataTable's dense rows, mobile fold and keyboard grid, with a divider row at each day in the viewer's zone. */
export function DayTable<Row>({
  columns,
  rows,
  getRowKey,
  getDate,
  label,
  onRowClick,
  activeKey,
  empty,
  error,
}: {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  getRowKey: (row: Row) => string;
  getDate: (row: Row) => Date;
  label: string;
  onRowClick: (row: Row) => void;
  activeKey?: string;
  empty: ReactNode;
  error?: ReactNode;
}) {
  const folded = (column: DataTableColumn<Row>) => column.priority !== "primary";
  const zone = useTimeZone();
  const headerOffset = useHeaderOffset();
  const now = new Date();
  const state = error ? "error" : rows.length === 0 ? "empty" : "rows";
  const groups = state === "rows" ? groupByDay(rows, getDate, zone) : [];
  const byKey = new Map(groups.flatMap((group) => group.items).map((row) => [getRowKey(row), row]));
  const { getRowProps } = useRowNavigation({
    keys: [...byKey.keys()],
    activeKey,
    onOpen: (key) => {
      const row = byKey.get(key);
      if (row) onRowClick(row);
    },
  });

  return (
    <div
      // Rows are the tab stop when there are any.
      tabIndex={state === "rows" ? undefined : 0}
      role="region"
      aria-label={label}
      className="w-full sm:overflow-auto md:overflow-visible focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      <table
        role={state === "rows" ? "grid" : undefined}
        aria-label={state === "rows" ? label : undefined}
        className="w-full border-collapse text-left text-sm"
      >
        <TableHead>
          <TableRow className="hover:bg-transparent">
            {columns.map((column) => (
              <TableHeaderCell
                key={column.key}
                scope="col"
                className={cn(
                  "px-3 py-2",
                  column.numeric && "text-right",
                  folded(column) && "hidden sm:table-cell",
                  column.headerClassName,
                )}
              >
                {column.header}
              </TableHeaderCell>
            ))}
          </TableRow>
        </TableHead>
        {state === "rows" ? (
          groups.map((group, index) => (
            <TableBody key={group.day}>
              <TableRow className="hover:bg-transparent">
                <th
                  scope="colgroup"
                  colSpan={columns.length}
                  style={{ top: headerOffset }}
                  className="sticky z-10 bg-background p-0 text-left text-2xs font-medium text-muted-foreground sm:static md:sticky"
                >
                  <span className="flex items-center justify-between gap-3 bg-muted/40 px-3 py-1.5">
                    <time dateTime={group.day}>{dayHeading(group.day, zone, now)}</time>
                    {index === 0 ? <ZoneNote /> : null}
                  </span>
                </th>
              </TableRow>
              {group.items.map((row) => {
                const key = getRowKey(row);
                return (
                    <TableRow
                      key={key}
                      {...getRowProps(key)}
                      aria-current={activeKey === key ? "true" : undefined}
                      onClick={() => onRowClick(row)}
                      // Clears the app header and the sticky day divider when arrowing scrolls the page.
                      style={{ scrollMarginTop: headerOffset + 32 }}
                      className={cn(
                        "cursor-pointer focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                        activeKey === key && "bg-accent/60",
                      )}
                    >
                      {columns.map((column) => (
                        <TableCell
                          key={column.key}
                          className={cn(
                            "px-3 py-2",
                            column.numeric && "text-right font-mono tabular-nums",
                            folded(column) && "hidden sm:table-cell",
                            column.cellClassName,
                          )}
                        >
                          {column.cell(row)}
                        </TableCell>
                      ))}
                    </TableRow>
                );
              })}
            </TableBody>
          ))
        ) : (
          <TableBody>
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columns.length} className="p-0">
                {state === "error" ? error : empty}
              </TableCell>
            </TableRow>
          </TableBody>
        )}
      </table>
    </div>
  );
}
