"use client";

import * as RadixPopover from "@radix-ui/react-popover";
import { cardVariants } from "@/components/ui/card";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";

// Popover — click-triggered floating panel for richer content than a
// Tooltip (forms, menus, detail cards). Radix owns positioning, focus
// management, and outside-click/Esc dismissal; this only supplies the
// Quiet Canvas skin plus the same starting-style entrance Tooltip uses.

export const PopoverRoot = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverAnchor = RadixPopover.Anchor;
export const PopoverClose = RadixPopover.Close;

/**
 * Radix renders this as `role="dialog"`, and a dialog with no name is a
 * serious axe violation — so `label` is required rather than optional. It was
 * previously possible, and easy, to ship an unnamed one.
 */
export function PopoverContent({
  className,
  label,
  sideOffset = 8,
  collisionPadding = 12,
  ...props
}: RadixPopover.PopoverContentProps & {
  /** Names the panel. Say what it holds, not that it's a popover. */
  label: string;
}) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        aria-label={label}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          cardVariants(),
          "z-50 w-72 rounded-2xl p-4 text-foreground shadow-overlay-md",
          // Never wider than the viewport less the collision padding on both sides.
          "max-w-[calc(100vw-1.5rem)]",
          // Radix moves focus here on open, so it is a focus stop and owes an
          // indicator — the drop shadow is there whether it is focused or not.
          FOCUS_RING,
          "transition-[opacity,transform] duration-150 ease-out",
          "starting:opacity-0 starting:scale-95",
          className,
        )}
        {...props}
      />
    </RadixPopover.Portal>
  );
}
