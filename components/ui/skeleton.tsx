import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Skeleton — a loading placeholder. Showing structure immediately, before
// real content arrives, keeps a page feeling responsive rather than
// stalled (Doherty Threshold: perceived latency matters as much as actual
// latency). Reduced motion is already covered by the site's global
// animation-duration guard in globals.css — no extra handling needed here.
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-lg bg-muted", className)} />;
}

/**
 * The announcement half of a loading state.
 *
 * Every Skeleton is `aria-hidden`, which is right for a single bar and leaves
 * a screen reader with silence for the whole load. Wrapping the bars in this
 * says something is coming, once, instead of each call site remembering to
 * hand-roll a live region — and `aria-busy` is what tells assistive tech to
 * hold off describing a region that is still filling in.
 */
export function SkeletonGroup({
  label = "Loading",
  className,
  children,
}: {
  /** Announced while the placeholder is up. Name the thing being loaded. */
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}
