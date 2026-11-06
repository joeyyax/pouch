"use client";

import { useId, useState, type PointerEvent } from "react";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format/number";

/** A daily trend under a number. Hover names the day; the number beside it carries the meaning. */
export function Sparkline({
  values,
  previous,
  labels,
  previousLabels,
  color = "var(--muted-foreground)",
  label,
  interactive = true,
  className,
}: {
  values: number[];
  /** The period before, aligned by index, drawn behind in the same hue at 30%. */
  previous?: number[];
  /** One per value, shown on hover. */
  labels?: string[];
  previousLabels?: string[];
  /** A CSS color, usually a token. */
  color?: string;
  /** What the trend is, for screen readers. */
  label: string;
  interactive?: boolean;
  className?: string;
}) {
  const gradient = useId();
  const [active, setActive] = useState<number | null>(null);
  if (values.length < 2) return null;

  const prior = previous && previous.length === values.length ? previous : null;
  const max = Math.max(...values, ...(prior ?? []), 1);
  const step = 100 / (values.length - 1);
  const x = (index: number) => index * step;
  // Two units of headroom keep a peak's stroke inside the box.
  const y = (value: number) => 30 - (value / max) * 28;
  const path = (series: number[]) => series.map((value, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(value)}`).join(" ");
  const line = path(values);
  const area = `${line} L100,32 L0,32 Z`;

  function onMove(event: PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
    setActive(Math.round(ratio * (values.length - 1)));
  }

  const point = active === null ? null : { left: `${x(active)}%`, top: `${(y(values[active] ?? 0) / 32) * 100}%` };

  return (
    <div
      className={cn("relative h-8 w-full", className)}
      role="img"
      aria-label={label}
      onPointerMove={interactive ? onMove : undefined}
      onPointerLeave={interactive ? () => setActive(null) : undefined}
    >
      <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="size-full overflow-visible" aria-hidden>
        <defs>
          <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.18} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gradient})`} />
        {prior ? (
          <path
            d={path(prior)}
            fill="none"
            stroke={color}
            strokeOpacity={0.3}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {point && active !== null ? (
        <>
          <span
            aria-hidden
            className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card"
            style={{ ...point, backgroundColor: color }}
          />
          {/* Below the line, so it never covers the number above. */}
          <span
            aria-hidden
            className="pointer-events-none absolute top-full z-10 mt-1.5 flex flex-col whitespace-nowrap rounded-md bg-foreground px-1.5 py-0.5 font-mono text-2xs tabular-nums text-background"
            style={{ left: point.left, transform: `translateX(-${(active / (values.length - 1)) * 100}%)` }}
          >
            <span>
              {labels?.[active] ? `${labels[active]} · ` : null}
              {formatNumber(values[active] ?? 0)}
            </span>
            {prior ? (
              <span className="opacity-60">
                {previousLabels?.[active] ? `${previousLabels[active]} · ` : "before · "}
                {formatNumber(prior[active] ?? 0)}
              </span>
            ) : null}
          </span>
        </>
      ) : null}
    </div>
  );
}
