import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface TimelineItem {
  /** A year, a step number, a timestamp — whatever the sequence is ordered by. */
  marker: ReactNode;
  title: string;
  description?: ReactNode;
}

// Timeline — a connected vertical rail of marker/title/description items.
// Generic enough to cover both a history ("2019 — Founded...") and a
// numbered process ("Step 1 — Sign up...") — one primitive instead of two
// near-identical ones. `dense` is the third job: an event log, where the
// marker is an exact time and the description is a provider's reason quoted
// verbatim, so a dozen rows have to fit a detail sidebar.
export function Timeline({
  items,
  dense = false,
  className,
}: {
  items: TimelineItem[];
  /** Tighter rows, smaller titles, a narrower marker column. For event logs. */
  dense?: boolean;
  className?: string;
}) {
  return (
    <ol className={cn("flex flex-col", className)}>
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        return (
          <li key={i} className={cn("flex", dense ? "gap-3" : "gap-6")}>
            {/* A floor, not a fixed width — "September 2024" wrapped to three
                lines against a single-line title at w-20 and threw the row's
                alignment out. Long markers now widen the column instead. */}
            <div className={cn("flex shrink-0 justify-end pt-0.5", dense ? "min-w-16" : "min-w-20")}>
              <span
                className={cn(
                  "font-mono font-semibold tabular-nums text-muted-foreground",
                  dense ? "text-2xs" : "text-sm",
                )}
              >
                {item.marker}
              </span>
            </div>
            <div className="flex flex-col items-center">
              <span
                aria-hidden
                className={cn("shrink-0 rounded-full bg-primary", dense ? "mt-1 size-2" : "mt-1.5 size-3")}
              />
              {!isLast ? <span aria-hidden className="w-px flex-1 bg-border" /> : null}
            </div>
            <div className={cn("min-w-0 flex-1", !isLast && (dense ? "pb-3" : "pb-8"))}>
              <p
                className={cn(
                  "text-foreground",
                  dense ? "text-sm font-semibold" : "type-display text-lg font-bold",
                )}
              >
                {item.title}
              </p>
              {item.description ? (
                <p className={cn("text-foreground-soft", dense ? "mt-0.5 text-2xs" : "type-body mt-1.5")}>
                  {item.description}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
