"use client";

import type { ReactNode } from "react";
import { CopyButton } from "@/components/ui/copy-field";
import { cn } from "@/lib/utils";

/** A value with a copy button that appears on hover or focus. Always shown where there's no hover, unless `hideOnTouch`. */
export function CopyOnHover({
  value,
  label,
  children,
  className,
  hideOnTouch = false,
  always = false,
  wrap = false,
}: {
  value: string;
  /** Names what gets copied: "address", "message id". */
  label: string;
  children: ReactNode;
  className?: string;
  /** For a dense row whose detail page carries its own copy button. */
  hideOnTouch?: boolean;
  /** Shows the button at rest, for a value whose whole job is to be copied. */
  always?: boolean;
  /** Wraps a long value instead of truncating it. */
  wrap?: boolean;
}) {
  return (
    <span className={cn("group/copy inline-flex min-w-0 max-w-full gap-1", wrap ? "items-start" : "items-center", className)}>
      <span className={wrap ? "min-w-0 [overflow-wrap:anywhere]" : "min-w-0 truncate"}>{children}</span>
      <span
        className={cn(
          "shrink-0",
          always
            ? null
            : "opacity-0 transition-opacity group-focus-within/copy:opacity-100 group-hover/copy:opacity-100",
          always ? null : hideOnTouch ? "[@media(hover:none)]:hidden" : "[@media(hover:none)]:opacity-100",
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <CopyButton value={value} label={label} />
      </span>
    </span>
  );
}
