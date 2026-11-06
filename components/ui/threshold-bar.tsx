import { cn } from "@/lib/utils";

export interface ThresholdMark {
  value: number;
  label: string;
}

export type ThresholdTone = "good" | "warn" | "issue" | "neutral";

const FILL: Record<ThresholdTone, string> = {
  good: "bg-success",
  warn: "bg-warning",
  issue: "bg-danger",
  neutral: "bg-muted-foreground",
};

/**
 * A value against ascending labeled lines. Each span between lines takes an equal share of the
 * track, so lines an order of magnitude apart stay readable. Labels end at their line.
 */
export function ThresholdBar({
  value,
  marks,
  tone = "neutral",
  label,
  className,
}: {
  /** Null draws the track and lines with no fill. */
  value: number | null;
  marks: ThresholdMark[];
  tone?: ThresholdTone;
  /** Read by assistive tech, since the bar itself is drawn. */
  label: string;
  className?: string;
}) {
  const stops = [0, ...marks.map((mark) => mark.value)];
  const share = 100 / marks.length;
  const position = (n: number) => {
    for (let i = 1; i < stops.length; i += 1) {
      const low = stops[i - 1] ?? 0;
      const high = stops[i] ?? low;
      if (n <= high) return (i - 1 + (high === low ? 0 : (n - low) / (high - low))) * share;
    }
    return 100;
  };
  const at = (n: number) => `${Math.max(0, position(n))}%`;
  const max = stops[stops.length - 1] ?? 0;
  return (
    <div className={cn("w-full", className)}>
      <div
        // A meter needs a value; with no reading it's a labeled image.
        {...(value === null
          ? { role: "img", "aria-label": label }
          : { role: "meter", "aria-label": label, "aria-valuemin": 0, "aria-valuemax": max, "aria-valuenow": value })}
        className="relative h-2 w-full rounded-full bg-secondary"
      >
        {value !== null ? (
          <div
            className={cn("absolute inset-y-0 left-0 rounded-full", FILL[tone])}
            style={{ width: value > 0 ? `max(${at(value)}, 0.375rem)` : 0 }}
          />
        ) : null}
        {marks.map((mark) => (
          <div
            key={mark.label}
            aria-hidden
            className="absolute -inset-y-1 w-px bg-foreground-soft"
            style={{ left: at(mark.value) }}
          />
        ))}
      </div>
      <div aria-hidden className="relative mt-1.5 h-4">
        {marks.map((mark) => (
          <span
            key={mark.label}
            className="absolute top-0 -translate-x-full whitespace-nowrap pr-1 text-2xs text-muted-foreground"
            style={{ left: at(mark.value) }}
          >
            {mark.label}
          </span>
        ))}
      </div>
    </div>
  );
}
