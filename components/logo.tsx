import { useId, type CSSProperties } from "react";
import { brand } from "@/lib/brand";
import { MARK_BODY, MARK_CUT, MARK_CUT_WIDTH, MARK_FLAP_REGION, MARK_HINGE } from "@/lib/brand-mark";
import { cn } from "@/lib/utils";

/** `hover` peeks the flap when the link around it is hovered, `sent` plays once, `wait` loops. The motion is in `app/brand.css`. */
export type MarkMotion = "hover" | "sent" | "wait";

const MASK_BOX = { maskUnits: "userSpaceOnUse", x: -4, y: -20, width: 40, height: 56 } as const;

/**
 * The mark, standing in for the wordmark wherever the product names itself.
 *
 * Colors come from the theme tokens rather than the literals in `app/icon.svg`: the favicon
 * follows the OS, this follows the app. It's drawn as flap and body, split at the cut, so the
 * flap can hinge.
 */
export function Logo({
  className,
  label = brand.name,
  motion,
  decorative = false,
}: {
  className?: string;
  label?: string;
  motion?: MarkMotion | MarkMotion[];
  /** Beside text that already says what's happening: hidden from assistive tech. */
  decorative?: boolean;
}) {
  const id = useId().replace(/[^\w-]/g, "");
  const motions = motion ? [motion].flat() : [];
  return (
    <svg
      viewBox="0 0 32 32"
      overflow="visible"
      className={cn("pouch-mark", className)}
      style={{ "--mark-hinge": `${MARK_HINGE}px` } as CSSProperties}
      data-motion={motions.length ? motions.join(" ") : undefined}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative || undefined}
      focusable="false"
    >
      <mask id={`${id}-body`} {...MASK_BOX}>
        <rect x="-4" y="-20" width="40" height="56" fill="#fff" />
        <path d={MARK_FLAP_REGION} fill="#000" />
        <path d={MARK_CUT} fill="none" stroke="#000" strokeWidth={MARK_CUT_WIDTH} />
      </mask>
      <mask id={`${id}-flap`} {...MASK_BOX}>
        <path d={MARK_FLAP_REGION} fill="#fff" />
        <path d={MARK_CUT} fill="none" stroke="#000" strokeWidth={MARK_CUT_WIDTH} />
      </mask>
      <g className="pouch-mark-flap">
        <path d={MARK_BODY} fill="var(--primary)" mask={`url(#${id}-flap)`} />
      </g>
      {motions.includes("sent") ? <rect className="pouch-mark-letter" x="11.5" y={MARK_HINGE - 8} width="9" height="7" rx="1.4" /> : null}
      <g className="pouch-mark-body">
        <path d={MARK_BODY} fill="var(--primary)" mask={`url(#${id}-body)`} />
      </g>
    </svg>
  );
}
