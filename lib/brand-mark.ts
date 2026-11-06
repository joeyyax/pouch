/**
 * The mark's geometry on a 32-unit grid: a tapered squircle with one flap cut. `components/logo.tsx`,
 * `app/icon.svg`, hosted pages and the generated icons all draw from these.
 */

/** The body: a superellipse (n 4) narrowing 12% toward the top. */
export const MARK_BODY =
  "M28.03 16.5C28.34 20.31 28.68 22.96 26.66 24.57C24.55 26.26 20.1 26.1 16 26.1C11.9 26.1 7.45 26.26 5.34 24.57C3.32 22.96 3.66 20.31 3.97 16.5C4.25 12.93 4.35 10.09 6.43 8.43C8.5 6.77 12.02 6.9 16 6.9C19.98 6.9 23.5 6.77 25.57 8.43C27.65 10.09 27.75 12.93 28.03 16.5Z";

/** The flap's edge, run past both sides so the cut reaches the silhouette. */
export const MARK_CUT = "M-1 11.4H1Q16 22 31 11.4H33";

/** Everything above the cut: the flap, once masked to the body. */
export const MARK_FLAP_REGION = "M-4 -20H36V11.4H31Q16 22 1 11.4H-4Z";

/** The body's top edge, where the flap hinges. */
export const MARK_HINGE = 6.9;

/** Cut width in grid units. Favicons at 16px take the heavier one. */
export const MARK_CUT_WIDTH = 2.4;
export const MARK_CUT_WIDTH_SMALL = 3.4;

/** The mark as one SVG string, its cut knocked out. `fill` is any CSS color. */
export function markSvg({ fill, cutWidth = MARK_CUT_WIDTH, attributes = "" }: { fill: string; cutWidth?: number; attributes?: string }): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"${attributes ? ` ${attributes}` : ""}><mask id="pouch-mark-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32"><rect width="32" height="32" fill="#fff"/><path d="${MARK_CUT}" fill="none" stroke="#000" stroke-width="${cutWidth}"/></mask><path d="${MARK_BODY}" style="fill:${fill}" mask="url(#pouch-mark-cut)"/></svg>`;
}
