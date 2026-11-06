"use client";

import { useRef, useState, type ReactNode } from "react";
import * as RadixPopover from "@radix-ui/react-popover";
import { cardVariants } from "@/components/ui/card";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";
import { GLOSSARY, type GlossaryTerm } from "./glossary";

const FOCUSABLE = "a[href], button:not([disabled])";

/**
 * A word that needs explaining, marked with a dotted underline. Hover opens it for a mouse, tap
 * for touch, focus for a keyboard. A popover rather than a tooltip, because tooltips never open on
 * touch.
 */
export function Term({
  term,
  definition,
  children,
  chip = false,
  className,
}: {
  term?: GlossaryTerm;
  /** For a one-off explanation that doesn't belong in the glossary. */
  definition?: ReactNode;
  children: ReactNode;
  /** The child is a chip, so the underline goes on it rather than around it. */
  chip?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointer = useRef<string | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const text = definition ?? (term ? GLOSSARY[term] : null);
  if (!text) return <>{children}</>;

  const hover = (next: boolean) => (event: { pointerType: string }) => {
    if (event.pointerType !== "mouse") return;
    if (closing.current) clearTimeout(closing.current);
    if (next) setOpen(true);
    else closing.current = setTimeout(() => setOpen(false), 120);
  };

  return (
    <RadixPopover.Root open={open} onOpenChange={setOpen}>
      <RadixPopover.Trigger
        asChild
        onClick={(event) => {
          // Inside a clickable row, the row mustn't navigate too.
          event.stopPropagation();
          const via = event.detail === 0 ? "keyboard" : pointer.current;
          pointer.current = null;
          if (via === "touch" || via === "pen") return;
          // A mouse already opened it on hover, and a key press moves into any link it holds.
          event.preventDefault();
          setOpen(true);
          if (via === "keyboard") requestAnimationFrame(() => content.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus());
        }}
      >
        <button
          type="button"
          onPointerDown={(event) => {
            pointer.current = event.pointerType;
          }}
          onPointerEnter={hover(true)}
          onPointerLeave={hover(false)}
          onFocus={(event) => {
            if (event.currentTarget.matches(":focus-visible")) setOpen(true);
          }}
          onBlur={(event) => {
            if (!content.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
          }}
          className={cn(
            "cursor-help text-inherit",
            chip
              ? "rounded-full *:underline *:decoration-current/50 *:decoration-dotted *:underline-offset-2"
              : "rounded-sm underline decoration-current/40 decoration-dotted underline-offset-4",
            FOCUS_RING,
            className,
          )}
        >
          {children}
        </button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          ref={content}
          side="top"
          sideOffset={6}
          collisionPadding={12}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onPointerEnter={hover(true)}
          onPointerLeave={hover(false)}
          // React events bubble through the portal, so a link in here would also click a row.
          onClick={(event) => event.stopPropagation()}
          className={cn(
            cardVariants(),
            "z-50 max-w-64 rounded-xl px-3 py-2 text-sm leading-snug text-foreground shadow-overlay-sm",
            "transition-[opacity,transform] duration-150 ease-out starting:scale-95 starting:opacity-0",
          )}
        >
          {text}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
