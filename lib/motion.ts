export const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

/** --ease-out as a CSS string (for WAAPI-based consumers like NumberFlow). */
export const EASE_OUT_CSS = "cubic-bezier(0.16, 1, 0.3, 1)";

/** Reveal duration — sections, load orchestration items (seconds, framer). */
export const DUR_REVEAL_S = 0.4;

/** Gap between top-level beats of the hero's load sequence (seconds). */
export const LOAD_STAGGER_S = 0.15;

/** Gap between staggered cards inside a beat (seconds). */
export const CARD_STAGGER_S = 0.06;

/** The score ring's draw-in — mirrors the 1.1s --sweep transition in CSS. */
export const RING_DRAW_MS = 1100;

/** Gap between quick-scan check rows resolving (ms). */
export const SCAN_CHECK_MS = 420;

/**
 * A dot whose pulse carries meaning, paired with the still equivalent reduced motion gets.
 * `motion-safe:` alone leaves a plain dot that reads the same as the state next to it, so the
 * ring has to say what the pulse said.
 */
export const PULSE_OR_RING = "motion-safe:animate-pulse motion-reduce:ring-2";
