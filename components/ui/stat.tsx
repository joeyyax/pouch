"use client";

import NumberFlow, { type Format } from "@number-flow/react";
import type { ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { EASE_OUT_CSS } from "@/lib/motion";
import { cn } from "@/lib/utils";

// Stat — a generic animated numeral + label (metrics grids, pricing pages,
// "years in business" callouts). Distinct from hero/score-card.tsx's
// bespoke gauge, which owns its own conic-ring, pointer-tilt and glow — this
// is just the count-up numeral on its own, for anywhere a plain number needs
// to feel alive when it enters or changes.
//
// Two faces, one component: `numeral` (the default — mono, tabular, the
// site's dashboard/measurement voice) and `display` (Bricolage at display
// scale — the number IS the section's headline moment, careers-page style).
// The face only changes the numeral's voice; label, count-up, delta, and
// StatBand's grid math are identical across both, so switching face is a
// one-prop restyle, not a different component.
export const statVariants = cva("leading-none text-foreground", {
  variants: {
    face: {
      numeral: "font-mono font-medium tracking-tight tabular-nums",
      // Bricolage like the headings, but deliberately NOT .type-display's
      // 750 — at headline scale that weight competes with the section title
      // for voice. Scale carries the number; medium keeps it airy enough
      // that the title stays the loudest thing in the room. tabular-nums
      // keeps a counting NumberFlow from wobbling where the face supports it.
      display: "[font-family:var(--font-display-var)] font-medium tracking-[-0.025em] tabular-nums",
    },
    size: {
      sm: "",
      md: "",
      lg: "",
    },
  },
  compoundVariants: [
    { face: "numeral", size: "sm", class: "text-2xl" },
    { face: "numeral", size: "md", class: "text-4xl" },
    { face: "numeral", size: "lg", class: "text-[56px]" },
    // The display ladder runs well past the mono one on purpose — a display
    // stat is a headline, and headline scale is what sells it. Fluid clamps,
    // same convention as the .type-h* ladder.
    { face: "display", size: "sm", class: "text-[clamp(2.6rem,5vw,3.4rem)]" },
    { face: "display", size: "md", class: "text-[clamp(3.4rem,7vw,4.75rem)]" },
    { face: "display", size: "lg", class: "text-[clamp(4.25rem,9vw,6.5rem)]" },
  ],
  defaultVariants: { face: "numeral", size: "md" },
});

export type StatFace = NonNullable<VariantProps<typeof statVariants>["face"]>;

// The delta mark's tone colors the mark only, never the numeral — same rule
// StatementList sets for its markers. Muted is the default on purpose: a
// benchmark comparison is a citation, not a scoreboard; reach for
// success/danger only when the direction really is the story.
export type StatDeltaTone = "muted" | "success" | "danger";

const DELTA_TONE: Record<StatDeltaTone, string> = {
  muted: "text-muted-foreground",
  success: "text-success-ink",
  danger: "text-danger",
};

/** The small raised benchmark mark beside a stat's numeral (`+4%` against an
 * industry average). Shared by both of StatBand's value branches so numbers
 * and static strings carry it identically. Sized in em so it tracks the
 * numeral's own scale. */
export function StatDelta({
  delta,
  tone = "muted",
  srLabel,
}: {
  delta: ReactNode;
  tone?: StatDeltaTone;
  srLabel?: string;
}) {
  return (
    <sup className={cn("ml-1 align-super text-[0.34em] font-semibold tracking-normal", DELTA_TONE[tone])}>
      {delta}
      {srLabel ? <span className="sr-only"> {srLabel}</span> : null}
    </sup>
  );
}

export function Stat({
  value,
  label,
  prefix,
  suffix,
  delta,
  deltaTone,
  deltaLabel,
  face,
  size,
  format,
  className,
  labelClassName,
}: VariantProps<typeof statVariants> & {
  value: number;
  label?: ReactNode;
  prefix?: string;
  suffix?: string;
  /** Benchmark comparison rendered as a small raised mark after the numeral,
   * e.g. `"+4%"`. Cite what it's against — pair with `deltaLabel` (read by
   * screen readers) and a visible footnote nearby naming the benchmark. */
  delta?: ReactNode;
  deltaTone?: StatDeltaTone;
  /** Screen-reader continuation of `delta`, e.g. "vs. industry average" —
   * without it the mark reads as a bare number. */
  deltaLabel?: string;
  format?: Format;
  className?: string;
  labelClassName?: string;
}) {
  return (
    <div className={cn("flex flex-col", className)}>
      <div className={statVariants({ face, size })}>
        {prefix}
        <NumberFlow value={value} format={format} transformTiming={{ duration: 600, easing: EASE_OUT_CSS }} />
        {suffix}
        {delta ? <StatDelta delta={delta} tone={deltaTone} srLabel={deltaLabel} /> : null}
      </div>
      {label ? <span className={cn("mt-1.5 text-sm text-muted-foreground", labelClassName)}>{label}</span> : null}
    </div>
  );
}
