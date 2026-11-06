"use client";

import { PULSE_OR_RING } from "@/lib/motion";
import type { LiveState } from "./use-live-updates";

/**
 * Says whether the screen is still keeping up. Quiet either way — it isn't an error.
 *
 * One wrapper across all four states, so aria-live has something stable to watch and a drop to
 * "not updating live" or "offline" is spoken rather than only drawn. "off" and "offline" read
 * differently on purpose: one is the stream giving up, the other is the network, and the fix
 * for each is different (reload vs. wait).
 *
 * The pulse on "live" is the signal, not decoration — with reduced motion it's replaced by a
 * static ring rather than just turning still, since a plain dot reads the same as "connecting".
 */
export function LiveIndicator({ state }: { state: LiveState }) {
  if (state === "off") {
    return (
      <span
        aria-live="polite"
        aria-atomic
        className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground"
      >
        Not updating live. Reload to see changes.
      </span>
    );
  }

  if (state === "offline") {
    return (
      <span
        aria-live="polite"
        aria-atomic
        className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground"
      >
        <span className="inline-block size-1.5 rounded-full bg-muted-foreground" aria-hidden />
        Offline. Live updates resume when you’re back.
      </span>
    );
  }

  return (
    <span
      aria-live="polite"
      aria-atomic
      className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground"
    >
      <span
        className={
          state === "live"
            ? `inline-block size-1.5 rounded-full bg-success ring-success/40 ${PULSE_OR_RING}`
            : "inline-block size-1.5 rounded-full bg-muted-foreground"
        }
        aria-hidden
      />
      {state === "live" ? "Live" : "Connecting"}
    </span>
  );
}
