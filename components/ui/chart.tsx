"use client";

import { useId, useMemo, type ReactNode } from "react";
import {
  Area,
  AreaChart as RechartsAreaChart,
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart as RechartsLineChart,
  Pie,
  PieChart as RechartsPieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import { useReducedMotion } from "framer-motion";
import { cva } from "class-variance-authority";
import { cardVariants } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// Quiet Canvas chart set — thin, token-only wrappers over Recharts so a call
// site stays declarative (`<LineChart data={rows} dataKey="visits" />`) and
// never touches a hex code. Law of Prägnanz: charts default to the simplest
// legible form — no vertical gridlines, no per-slice labels, no axis lines,
// dots only on hover — chrome earns its place or it's cut. Every series
// color comes from an ordered token ramp (never a literal), so a reskin that
// changes --primary/--tertiary/etc. reskins every chart with zero edits here.
//
// Recharts v3 gotcha worth knowing: the friendly `<LineChart>`/`<BarChart>`/
// `<PieChart>` wrappers turn on an internal `accessibilityLayer` by default,
// which makes the chart's own `<svg>` keyboard-focusable (tabIndex=0,
// role="application") with its own arrow-key data exploration. That's a
// real, useful feature — but it fights a chart that's meant to read as one
// opaque figure (this brief's ask). We turn it off (`accessibilityLayer=
// {false}`) and apply our own `role="img"` + `aria-label`/`aria-describedby`
// on the wrapping element instead, so the whole chart collapses to a single
// labeled image for AT users, with a real (not just SVG <desc>) visually-
// hidden summary paragraph underneath for anyone who wants the numbers in
// prose. We still pass `title`/`desc` straight through to Recharts too
// (they render as native <title>/<desc> inside the SVG) as a free,
// type-safe belt-and-suspenders reinforcement of the same name/description.

const SERIES_COLOR_TOKENS: [string, ...string[]] = [
  "var(--primary)",
  "var(--tertiary)",
  "var(--success)",
  "var(--warning)",
  "var(--danger)",
  "var(--accent-foreground)",
];

function colorForIndex(index: number) {
  return SERIES_COLOR_TOKENS[index % SERIES_COLOR_TOKENS.length] ?? SERIES_COLOR_TOKENS[0];
}

/** One row of chart data — values are read out by `dataKey`/`xKey` strings. */
export type ChartDatum = Record<string, string | number | null | undefined>;

/** A single line/bar series. Color falls back to the house token ramp by position. */
export interface ChartSeriesDef {
  /** Key into each `data` row this series reads its value from. */
  key: string;
  /** Legend/tooltip label. Falls back to `key`. */
  label?: string;
  /** Token color override (e.g. `"var(--danger)"`). Rare — prefer the ramp. */
  color?: string;
}

type SeriesInput =
  | { dataKey: string; series?: undefined }
  | { series: ChartSeriesDef[]; dataKey?: undefined };

function resolveSeries({ dataKey, series }: { dataKey?: string; series?: ChartSeriesDef[] }) {
  const defs = series?.length ? series : dataKey ? [{ key: dataKey }] : [];
  return defs.map((s, i) => ({
    key: s.key,
    label: s.label ?? s.key,
    color: s.color ?? colorForIndex(i),
  }));
}

// The wrapper's own layout rhythm (gap between plot / legend / summary).
// `area` and `dense` are both plain adjective props per component below —
// `dense` doubles as this className recipe since it genuinely changes
// spacing; `area` doesn't (it swaps which Recharts primitive renders), so
// it stays a plain boolean rather than forcing a variant that has no class.
export const chartVariants = cva("flex w-full flex-col", {
  variants: {
    dense: {
      true: "gap-2",
      false: "gap-3",
    },
  },
  defaultVariants: { dense: false },
});

function tickStyle(dense?: boolean) {
  return { fill: "var(--muted-foreground)", fontSize: dense ? 11 : 12 };
}

function plotMargin(dense?: boolean) {
  return dense ? { top: 4, right: 8, bottom: 0, left: 0 } : { top: 8, right: 12, bottom: 0, left: 0 };
}

// Shared legend row — a colored dot (inline style, since the color is a
// per-series CSS var string, not a Tailwind class) plus the label. Only
// rendered when it earns its space (see each component's `legend` default).
function ChartLegend({
  items,
  dense,
}: {
  items: Array<{ key: string; label: string; color: string }>;
  dense?: boolean;
}) {
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-1", dense ? "text-2xs" : "text-xs")}>
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-1.5 text-muted-foreground">
          <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

// Custom tooltip content, styled as a card surface per the brief (reuses
// cardVariants — same recipe select.tsx's floating panel uses — rather than
// hand-rolling a bg/border/shadow combo). Recharts clones/calls this with
// its own payload; we just format it with tokens.
function ChartTooltipContent({
  active,
  payload,
  label,
  valueFormatter,
}: TooltipContentProps & { valueFormatter?: (value: number) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className={cn(cardVariants(), "min-w-32 px-3 py-2")}>
      {label != null ? <p className="mb-1 text-xs font-medium text-foreground">{label}</p> : null}
      <ul className="flex flex-col gap-1">
        {payload.map((item, i) => {
          const numeric = typeof item.value === "number" ? item.value : Number(item.value);
          const percent = (item.payload as { percent?: number } | undefined)?.percent;
          return (
            <li key={String(item.dataKey ?? item.name ?? i)} className="flex items-center gap-2 text-xs">
              <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
              <span className="text-muted-foreground">{item.name}</span>
              <span className="ml-auto font-mono tabular-nums text-foreground">
                {Number.isFinite(numeric) && valueFormatter ? valueFormatter(numeric) : String(item.value)}
                {percent != null ? ` (${Math.round(percent * 100)}%)` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export type LineChartProps = {
  data: ChartDatum[];
  /** Category key read for the x-axis. @default "name" */
  xKey?: string;
  height?: number;
  /** Filled-area variant instead of a bare line. */
  area?: boolean;
  /** Tighter ticks/margins/legend for compact placements (cards, sidebars). */
  dense?: boolean;
  /** Force the legend on/off. Defaults to on only once there's >1 series (Hick's Law — one series doesn't need a key). */
  legend?: boolean;
  /** Formats tooltip + y-axis values (e.g. currency, percent). */
  valueFormatter?: (value: number) => string;
  /** Required accessible name — charts are opaque to screen readers without it. */
  title: string;
  /** Optional plain-language description, rendered visually hidden for AT users. */
  summary?: string;
  className?: string;
} & SeriesInput;

export function LineChart({
  data,
  xKey = "name",
  height = 240,
  area = false,
  dense = false,
  legend,
  valueFormatter,
  title,
  summary,
  className,
  dataKey,
  series,
}: LineChartProps) {
  const reduced = useReducedMotion();
  const descId = useId();
  const resolved = useMemo(() => resolveSeries({ dataKey, series }), [dataKey, series]);
  const showLegend = legend ?? resolved.length > 1;
  const Wrapper = area ? RechartsAreaChart : RechartsLineChart;

  return (
    <figure className={cn(chartVariants({ dense }), className)}>
      <div role="img" aria-label={title} aria-describedby={summary ? descId : undefined} style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <Wrapper
            data={data}
            margin={plotMargin(dense)}
            accessibilityLayer={false}
            role="img"
            title={title}
            desc={summary}
          >
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey={xKey} stroke="var(--border)" tickLine={false} axisLine={false} tick={tickStyle(dense)} tickMargin={8} />
            <YAxis
              stroke="var(--border)"
              tickLine={false}
              axisLine={false}
              tick={tickStyle(dense)}
              tickFormatter={valueFormatter}
            />
            <Tooltip
              cursor={{ stroke: "var(--border)" }}
              content={(p) => <ChartTooltipContent {...p} valueFormatter={valueFormatter} />}
            />
            {resolved.map((s) =>
              area ? (
                <Area
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label}
                  stroke={s.color}
                  fill={s.color}
                  fillOpacity={0.16}
                  strokeWidth={dense ? 1.5 : 2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  isAnimationActive={!reduced}
                  animationDuration={500}
                />
              ) : (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label}
                  stroke={s.color}
                  strokeWidth={dense ? 1.5 : 2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  isAnimationActive={!reduced}
                  animationDuration={500}
                />
              ),
            )}
          </Wrapper>
        </ResponsiveContainer>
      </div>
      {showLegend ? <ChartLegend items={resolved} dense={dense} /> : null}
      {summary ? (
        <p id={descId} className="sr-only">
          {summary}
        </p>
      ) : null}
    </figure>
  );
}

export type BarChartProps = {
  data: ChartDatum[];
  xKey?: string;
  height?: number;
  dense?: boolean;
  legend?: boolean;
  /** Stack the series into one bar per category instead of standing them side by side. */
  stacked?: boolean;
  valueFormatter?: (value: number) => string;
  title: string;
  summary?: string;
  className?: string;
} & SeriesInput;

export function BarChart({
  data,
  xKey = "name",
  height = 240,
  dense = false,
  legend,
  stacked = false,
  valueFormatter,
  title,
  summary,
  className,
  dataKey,
  series,
}: BarChartProps) {
  const reduced = useReducedMotion();
  const descId = useId();
  const resolved = useMemo(() => resolveSeries({ dataKey, series }), [dataKey, series]);
  const showLegend = legend ?? resolved.length > 1;

  return (
    <figure className={cn(chartVariants({ dense }), className)}>
      <div role="img" aria-label={title} aria-describedby={summary ? descId : undefined} style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <RechartsBarChart
            data={data}
            margin={plotMargin(dense)}
            accessibilityLayer={false}
            role="img"
            title={title}
            desc={summary}
            barCategoryGap={dense ? "16%" : "24%"}
          >
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey={xKey} stroke="var(--border)" tickLine={false} axisLine={false} tick={tickStyle(dense)} tickMargin={8} />
            <YAxis
              stroke="var(--border)"
              tickLine={false}
              axisLine={false}
              tick={tickStyle(dense)}
              tickFormatter={valueFormatter}
            />
            <Tooltip
              cursor={{ fill: "var(--muted)" }}
              content={(p) => <ChartTooltipContent {...p} valueFormatter={valueFormatter} />}
            />
            {resolved.map((s) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                fill={s.color}
                stackId={stacked ? "stack" : undefined}
                // Only the topmost segment of a stack gets the rounded cap; rounding every
                // segment carves notches out of the bar.
                radius={stacked && s.key !== resolved[resolved.length - 1]?.key ? 0 : dense ? [3, 3, 0, 0] : [4, 4, 0, 0]}
                maxBarSize={dense ? 32 : 48}
                isAnimationActive={!reduced}
                animationDuration={500}
              />
            ))}
          </RechartsBarChart>
        </ResponsiveContainer>
      </div>
      {showLegend ? <ChartLegend items={resolved} dense={dense} /> : null}
      {summary ? (
        <p id={descId} className="sr-only">
          {summary}
        </p>
      ) : null}
    </figure>
  );
}

export interface DonutChartProps {
  data: ChartDatum[];
  /** Value key per row. @default "value" */
  dataKey?: string;
  /** Label key per row. @default "name" */
  nameKey?: string;
  height?: number;
  dense?: boolean;
  /** @default true — a donut without a key is hard to read. */
  legend?: boolean;
  valueFormatter?: (value: number) => string;
  /** Rendered in the ring's center (e.g. a total or headline stat). */
  centerLabel?: ReactNode;
  centerSubLabel?: ReactNode;
  title: string;
  summary?: string;
  className?: string;
}

export function DonutChart({
  data,
  dataKey = "value",
  nameKey = "name",
  height = 240,
  dense = false,
  legend = true,
  valueFormatter,
  centerLabel,
  centerSubLabel,
  title,
  summary,
  className,
}: DonutChartProps) {
  const reduced = useReducedMotion();
  const descId = useId();
  const resolved = useMemo(
    () =>
      data.map((d, i) => ({
        key: String(d[nameKey] ?? i),
        label: String(d[nameKey] ?? ""),
        color: (typeof d.color === "string" ? d.color : undefined) ?? colorForIndex(i),
      })),
    [data, nameKey],
  );

  return (
    <figure className={cn(chartVariants({ dense }), className)}>
      <div
        role="img"
        aria-label={title}
        aria-describedby={summary ? descId : undefined}
        className="relative"
        style={{ height }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <RechartsPieChart accessibilityLayer={false} role="img" title={title} desc={summary}>
            <Tooltip content={(p) => <ChartTooltipContent {...p} valueFormatter={valueFormatter} />} />
            <Pie
              data={data}
              dataKey={dataKey}
              nameKey={nameKey}
              cx="50%"
              cy="50%"
              innerRadius="60%"
              outerRadius="88%"
              paddingAngle={2}
              cornerRadius={4}
              stroke="var(--card)"
              strokeWidth={2}
              label={false}
              labelLine={false}
              isAnimationActive={!reduced}
              animationDuration={500}
            >
              {resolved.map((r) => (
                <Cell key={r.key} fill={r.color} />
              ))}
            </Pie>
          </RechartsPieChart>
        </ResponsiveContainer>
        {centerLabel ? (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            <span className="type-display text-2xl text-foreground">{centerLabel}</span>
            {centerSubLabel ? <span className="mt-0.5 text-xs text-muted-foreground">{centerSubLabel}</span> : null}
          </div>
        ) : null}
      </div>
      {legend ? <ChartLegend items={resolved} dense={dense} /> : null}
      {summary ? (
        <p id={descId} className="sr-only">
          {summary}
        </p>
      ) : null}
    </figure>
  );
}

export interface SparklineProps {
  data: ChartDatum[];
  dataKey: string;
  /** @default 32 — a tiny inline trend, not a full chart. */
  height?: number;
  /** Subtle gradient fill under the line instead of a bare stroke. */
  area?: boolean;
  /** Token color (e.g. `"var(--success)"`). @default "var(--primary)" */
  color?: string;
  title: string;
  summary?: string;
  className?: string;
}

/** Tiny inline trend line — no axes, grid, tooltip, or legend by design. */
export function Sparkline({
  data,
  dataKey,
  height = 32,
  area = false,
  color = "var(--primary)",
  title,
  summary,
  className,
}: SparklineProps) {
  const reduced = useReducedMotion();
  const descId = useId();
  const gradId = useId().replace(/:/g, "");

  return (
    <div
      role="img"
      aria-label={title}
      aria-describedby={summary ? descId : undefined}
      className={cn("w-full", className)}
      style={{ height }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <RechartsAreaChart
          data={data}
          accessibilityLayer={false}
          role="img"
          title={title}
          desc={summary}
          margin={{ top: 2, right: 2, bottom: 2, left: 2 }}
        >
          {area ? (
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
          ) : null}
          <Area
            type="monotone"
            dataKey={dataKey}
            stroke={color}
            strokeWidth={1.75}
            fill={area ? `url(#${gradId})` : "none"}
            dot={false}
            isAnimationActive={!reduced}
            animationDuration={500}
          />
        </RechartsAreaChart>
      </ResponsiveContainer>
      {summary ? (
        <p id={descId} className="sr-only">
          {summary}
        </p>
      ) : null}
    </div>
  );
}
