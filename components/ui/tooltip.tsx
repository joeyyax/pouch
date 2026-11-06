"use client";

import type { ReactNode } from "react";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import { cardVariants } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// Tooltip — short, non-interactive hints on hover/focus. Radix owns the
// delay, hover/focus intent tracking, positioning and ARIA (describedby);
// this only supplies the Quiet Canvas skin and a starting-style fade+scale
// entrance (CSS only — no JS animation needed for a one-way, no-exit pop-in,
// and it's already covered by the site's global reduced-motion transition
// guard in globals.css).
//
// No app-level `TooltipProvider`: `Tooltip` carries its own. Compose
// `TooltipProvider`/`TooltipRoot` directly for hover-delay grouping.

export const TooltipProvider = RadixTooltip.Provider;
export const TooltipRoot = RadixTooltip.Root;
export const TooltipTrigger = RadixTooltip.Trigger;

export function TooltipContent({ className, sideOffset = 8, ...props }: RadixTooltip.TooltipContentProps) {
  return (
    <RadixTooltip.Portal>
      <RadixTooltip.Content
        sideOffset={sideOffset}
        className={cn(
          cardVariants(),
          "z-50 max-w-64 rounded-xl px-3 py-2 text-sm text-foreground shadow-overlay-sm",
          "transition-[opacity,transform] duration-150 ease-out",
          "starting:opacity-0 starting:scale-95",
          className,
        )}
        {...props}
      />
    </RadixTooltip.Portal>
  );
}

// The common case: hover/focus a trigger, see a label. Reach for the
// Provider/Root/Trigger/Content pieces directly for multi-tooltip
// coordination or a custom trigger element.
/**
 * Carries its own provider, so a Tooltip — and anything built on one, like
 * IconButton — renders on a bare page, in a test and in a story without an
 * ancestor to supply context. Radix's Root throws outright without one.
 *
 * The trade is the cross-tooltip skip-delay grouping a single shared provider
 * gives you (hover one, its neighbors open instantly). `delayDuration`
 * defaults to the app's own 200ms so the feel is unchanged; a caller wanting
 * the grouping can still compose TooltipProvider/TooltipRoot directly.
 */
export function Tooltip({
  children,
  content,
  side,
  align,
  delayDuration = 200,
}: {
  children: ReactNode;
  content: ReactNode;
  side?: RadixTooltip.TooltipContentProps["side"];
  align?: RadixTooltip.TooltipContentProps["align"];
  delayDuration?: number;
}) {
  return (
    <TooltipProvider delayDuration={delayDuration}>
      <TooltipRoot>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} align={align}>
          {content}
        </TooltipContent>
      </TooltipRoot>
    </TooltipProvider>
  );
}
