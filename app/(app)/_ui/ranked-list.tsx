import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format/number";

export interface RankedItem {
  key: string;
  label: ReactNode;
  count: number;
  href?: string;
  /** Full text on hover, for a label that truncates. */
  title?: string;
  /** Overrides the list's tone for this row. */
  tone?: keyof typeof TONE;
}

const TONE = {
  danger: "bg-danger-soft/70",
  warn: "bg-warning-soft/80",
  neutral: "bg-muted",
  signal: "bg-accent",
  success: "bg-success-soft",
};

/** The under-bar is thin, so it takes the ink rather than the soft fill. */
const SLIM_TONE: Record<keyof typeof TONE, string> = {
  danger: "bg-danger/60",
  warn: "bg-warning/60",
  neutral: "bg-muted-foreground/35",
  signal: "bg-primary/50",
  success: "bg-success/60",
};

/** Rows with a bar behind each, sized to its share of the largest, so the dominant one shows at a glance. */
export function RankedList({
  items,
  tone = "neutral",
  mono = false,
  wrap = false,
}: {
  items: RankedItem[];
  tone?: keyof typeof TONE;
  mono?: boolean;
  /** Wrap long labels instead of truncating, for text a phone reader can't hover to see. */
  wrap?: boolean;
}) {
  const top = Math.max(...items.map((item) => item.count), 1);
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((item) => {
        const share = item.count / top;
        const body = (
          <>
            {item.count === 0 ? null : wrap ? (
              // Wrapped text would turn a full-height fill into a blob, so the bar runs under it.
              <span
                aria-hidden
                className={cn("absolute bottom-1.5 left-3 h-1 rounded-full", SLIM_TONE[item.tone ?? tone])}
                style={{ width: `max(calc((100% - 1.5rem) * ${share}), 0.5rem)` }}
              />
            ) : (
              <span
                aria-hidden
                className={cn("absolute inset-y-0 left-0", TONE[item.tone ?? tone])}
                // A floor so a small count still reads as a bar.
                style={{ width: `max(${share * 100}%, calc(var(--radius-sm) + 0.5rem))` }}
              />
            )}
            <span
              className={cn("relative min-w-0 flex-1 text-sm text-foreground", wrap ? "break-words" : "truncate", mono ? "font-mono" : null)}
              title={item.title}
            >
              {item.label}
            </span>
            <span className="relative font-mono text-sm tabular-nums text-foreground">{formatNumber(item.count)}</span>
          </>
        );
        const className = cn(
          "relative flex items-baseline justify-between gap-6 overflow-hidden rounded-sm px-3",
          wrap ? "pb-4 pt-2" : "py-2",
        );
        return (
          <li key={item.key}>
            {item.href ? (
              <Link href={item.href} className={cn(className, "hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring")}>
                {body}
              </Link>
            ) : (
              <div className={className}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
