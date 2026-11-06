"use client";

import { createContext, useContext } from "react";
import * as RadixTabs from "@radix-ui/react-tabs";
import { cardVariants } from "@/components/ui/card";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";

// Tabs — a segmented pill control. The track reads as a recessed groove
// (pill-card-recessed) with the active trigger sitting up out of it like a
// small pill-card of its own — the same raised/recessed pairing the rest of
// Quiet Canvas uses, just at pill scale. Radix owns keyboard nav (arrow keys
// move focus — up/down instead of left/right once `orientation="vertical"`
// is passed to TabsRoot, which is all switching layouts takes) and ARIA.
// Orientation drives layout entirely off Radix's own `data-orientation`
// attribute — no separate prop to keep in sync.

export const TabsRoot = RadixTabs.Root;

export type TabsSize = "md" | "sm";

const TabsSizeContext = createContext<TabsSize>("md");

// "sm" fits more tabs in a narrow panel: tighter triggers, and the row scrolls sideways
// instead of clipping when they still don't fit.
const TRIGGER_SIZE: Record<TabsSize, string> = {
  md: "px-4 py-2 text-sm",
  sm: "shrink-0 whitespace-nowrap px-3 py-1.5 text-xs sm:text-sm",
};

export function TabsList({ size = "md", className, ...props }: RadixTabs.TabsListProps & { size?: TabsSize }) {
  return (
    <TabsSizeContext.Provider value={size}>
      <RadixTabs.List
        className={cn(
          cardVariants({ variant: "recessed" }),
          "inline-flex items-center gap-1 rounded-full p-1",
          size === "sm" && "max-w-full overflow-x-auto overscroll-x-contain [scrollbar-width:none]",
          "data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-stretch data-[orientation=vertical]:rounded-2xl",
          className,
        )}
        {...props}
      />
    </TabsSizeContext.Provider>
  );
}

export function TabsTrigger({ className, ...props }: RadixTabs.TabsTriggerProps) {
  const size = useContext(TabsSizeContext);
  return (
    <RadixTabs.Trigger
      className={cn(
        // The ring is not optional: tabs are arrow-key navigated, so without a
        // visible indicator the focused tab is unknowable — `outline-none`
        // alone left this the one interactive primitive in the kit with no
        // focus treatment at all.
        "press relative rounded-full font-semibold text-muted-foreground transition-colors pointer-coarse:min-h-11",
        TRIGGER_SIZE[size],
        FOCUS_RING,
        "data-[state=active]:bg-card data-[state=active]:text-card-foreground data-[state=active]:shadow-card",
        "data-[orientation=vertical]:w-full data-[orientation=vertical]:rounded-xl data-[orientation=vertical]:text-left",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: RadixTabs.TabsContentProps) {
  return (
    <RadixTabs.Content
      // Radix makes the panel a tab stop so its content is reachable, which
      // means it needs an indicator like any other — `outline-none` alone
      // sent the caret somewhere nothing on screen changed.
      className={cn(
        "mt-4 rounded-2xl data-[orientation=vertical]:mt-0",
        FOCUS_RING,
        className,
      )}
      {...props}
    />
  );
}
