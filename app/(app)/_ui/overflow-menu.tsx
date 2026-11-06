"use client";

import Link from "next/link";
import { useState, type MouseEvent } from "react";
import { PopoverContent, PopoverRoot, PopoverTrigger } from "@/components/ui/popover";
import { cardVariants } from "@/components/ui/card";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";

export interface OverflowAction {
  label: string;
  onSelect?: (event: MouseEvent<HTMLElement>) => void;
  href?: string;
  /** The href is a file, so it downloads instead of navigating. */
  download?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  /** Why it's disabled, shown in place of nothing. */
  reason?: string;
  /** Only in the touch menu, for something hover already offers another way. */
  touchOnly?: boolean;
}

/** Secondary actions behind "…", so a header keeps one primary button. */
export function OverflowMenu({
  actions,
  label = "More actions",
  size = "md",
}: {
  /** A falsy entry is left out, so a conditional action can sit inline. */
  actions: (OverflowAction | false | null | undefined)[];
  label?: string;
  /** `sm` sits beside a small button inside a card. */
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  const visible = actions.filter((action): action is OverflowAction => Boolean(action));
  if (visible.length === 0) return null;

  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(cardVariants(), "press grid place-items-center rounded-full text-foreground", size === "sm" ? "size-9" : "size-11", FOCUS_RING)}
        >
          <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
            <circle cx="5" cy="12" r="1.75" fill="currentColor" />
            <circle cx="12" cy="12" r="1.75" fill="currentColor" />
            <circle cx="19" cy="12" r="1.75" fill="currentColor" />
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent label={label} align="end" className="w-56 p-1.5">
        <ul className="flex flex-col">
          {visible.map((action) => {
            const className = cn(
              "flex w-full flex-col rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors",
              action.destructive ? "text-danger hover:bg-danger-soft" : "text-foreground hover:bg-muted",
              action.disabled ? "pointer-events-none opacity-50" : null,
              FOCUS_RING,
            );
            const body = (
              <>
                {action.label}
                {action.disabled && action.reason ? (
                  <span className="text-xs font-normal text-muted-foreground">{action.reason}</span>
                ) : null}
              </>
            );
            return (
              <li key={action.label}>
                {action.href && action.download && !action.disabled ? (
                  <a href={action.href} download className={className} onClick={() => setOpen(false)}>
                    {body}
                  </a>
                ) : action.href && !action.disabled ? (
                  <Link href={action.href} className={className} onClick={() => setOpen(false)}>
                    {body}
                  </Link>
                ) : (
                  <button
                    type="button"
                    disabled={action.disabled}
                    className={className}
                    onClick={(event) => {
                      setOpen(false);
                      action.onSelect?.(event);
                    }}
                  >
                    {body}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </PopoverRoot>
  );
}
