"use client";

import { useState, type PointerEvent } from "react";
import { cn } from "@/lib/utils";
import { dayKey, shortDay, type DayCount } from "@/lib/dashboard/views/days";
import { useTimeZone } from "./time-zone";
import { formatNumber } from "@/lib/format/number";

/** One neutral bar per day, with the flagged part in red at its base. Hover or tap names the day. */
export function DayBars({
  days,
  label,
  unit,
  className,
}: {
  days: DayCount[];
  /** What the chart shows, for screen readers. */
  label: string;
  /** Singular and plural, for the hover: `["message", "messages"]`. */
  unit: [string, string];
  className?: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const zone = useTimeZone();
  if (days.length === 0) return null;

  const max = Math.max(...days.map((day) => day.total), 1);
  const today = dayKey(new Date(), zone);
  const first = days[0];
  const last = days.at(-1);
  const gap = days.length > 180 ? "gap-0" : days.length > 60 ? "gap-px" : "gap-0.5";

  function pick(event: PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 0.9999);
    setActive(Math.floor(ratio * days.length));
  }

  const shown = active === null ? null : days[active];

  return (
    <figure className={cn("flex flex-col gap-1.5", className)}>
      <div
        role="img"
        aria-label={label}
        className={cn("relative flex h-12 items-end touch-pan-y", gap)}
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={() => setActive(null)}
      >
        {days.map((day, index) => {
          const height = (day.total / max) * 100;
          const flagged = day.total > 0 ? (day.flagged / day.total) * 100 : 0;
          return (
            <div
              key={day.day}
              data-volume-day={day.day}
              className={cn(
                "flex h-full min-w-0 flex-1 flex-col justify-end transition-opacity",
                active !== null && active !== index && "opacity-50",
              )}
            >
              {day.total === 0 ? (
                <span aria-hidden className="h-px w-full bg-border" />
              ) : (
                <span
                  aria-hidden
                  className="flex min-h-0.5 w-full flex-col justify-end overflow-hidden rounded-t-[2px] bg-muted-foreground/45"
                  style={{ height: `${height}%` }}
                >
                  {day.flagged > 0 ? (
                    <span className="w-full bg-danger" style={{ height: `max(2px, ${flagged}%)` }} />
                  ) : null}
                </span>
              )}
            </div>
          );
        })}

        {shown && active !== null ? (
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute top-full z-20 mt-1.5 min-w-32 whitespace-nowrap rounded-md border border-border bg-card px-2.5 py-1.5 text-xs shadow-md",
              active > days.length / 2 ? "-translate-x-full" : null,
            )}
            style={{ left: `${((active + (active > days.length / 2 ? 0 : 1)) / days.length) * 100}%` }}
          >
            <p className="font-medium text-foreground">{shown.day === today ? "Today" : shortDay(shown.day)}</p>
            <p className="font-mono tabular-nums text-foreground-soft">
              {formatNumber(shown.total)} {shown.total === 1 ? unit[0] : unit[1]}
            </p>
            {(shown.breakdown ?? []).map(([name, count]) => (
              <p key={name} className="flex items-center gap-1.5 font-mono tabular-nums text-foreground-soft">
                <span className="size-1.5 shrink-0 rounded-full bg-danger" />
                {formatNumber(count)} {name}
              </p>
            ))}
          </div>
        ) : null}
      </div>
      <div aria-hidden className="flex justify-between text-2xs text-muted-foreground">
        <span>{first ? shortDay(first.day) : null}</span>
        <span>{last ? (last.day === today ? "Today" : shortDay(last.day)) : null}</span>
      </div>
    </figure>
  );
}
