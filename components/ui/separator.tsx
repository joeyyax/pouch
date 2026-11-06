"use client";

import * as RadixSeparator from "@radix-ui/react-separator";
import { cn } from "@/lib/utils";

// Separator — a plain divider, horizontal or vertical. Replaces the
// hand-rolled `border-t border-border` divs scattered through section
// wrappers with one primitive that also carries the correct ARIA
// (decorative by default; pass decorative={false} when it's actually
// separating distinct sections of content, not just visual rhythm).
export function Separator({
  orientation = "horizontal",
  decorative = true,
  className,
  ...props
}: RadixSeparator.SeparatorProps) {
  return (
    <RadixSeparator.Root
      orientation={orientation}
      decorative={decorative}
      className={cn(
        "bg-border",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
      {...props}
    />
  );
}
