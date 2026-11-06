"use client";

import { useId, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { StatusMark } from "@/components/ui/status-dot";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";

/** One quiet line standing in for the healthy rows, which it opens on request. */
export function HealthyLoops({ label, bordered, children }: { label: string; bordered: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex w-full items-center gap-2 p-5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/50",
          bordered && "border-t border-border",
          FOCUS_RING,
          "focus-visible:ring-inset focus-visible:ring-offset-0",
        )}
      >
        <StatusMark tone="good" />
        <span className="min-w-0 flex-1">{label}</span>
        <Icon name="chevron" className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <ul id={listId} className="border-t border-border">
          {children}
        </ul>
      ) : null}
    </>
  );
}
