"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button";
import {
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalRoot,
  ModalTitle,
} from "@/components/ui/modal";
import { shortcutKey } from "@/lib/keyboard";
import { cn } from "@/lib/utils";

// DetailPanel — a record opened over the list it came from, so the list
// context survives the trip. Header, a main area with its own tab slot, and
// a sidebar that scrolls independently on desktop; under md it's a bottom
// sheet with the page peeking above, and the two panels stack into one scroll. Built on
// ModalRoot/ModalContent, so the focus trap, focus return and Escape are
// Radix's, not re-implemented here. It knows nothing about routing: the
// caller owns `open`, and owns keeping the URL in step with it. With
// `onPrevious`/`onNext`, J/K and Up/Down step to the neighboring record.
// Set by a step, read by the panel that mounts next. A caller whose route
// change remounts the panel still gets one that appears in place.
let stepping = false;

export function DetailPanel({
  open,
  onOpenChange,
  title,
  chip,
  description,
  actions,
  tabs,
  sidebar,
  closeLabel = "Close",
  onCloseAutoFocus,
  onPrevious,
  onNext,
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Status, beside the title. A Chip, usually. */
  chip?: ReactNode;
  /** The one line under the title: who it went to, from where, when. */
  description?: ReactNode;
  /** Header actions, left of the close button. */
  actions?: ReactNode;
  /** Sits above the main area — a TabsList, usually, with its TabsContent
   * passed as children. */
  tabs?: ReactNode;
  /** The right column: a timeline, a facts panel. Omit for one full-width area. */
  sidebar?: ReactNode;
  closeLabel?: string;
  /** Where focus goes on close. Without it, focus falls to <body> when the row that opened the
   * panel re-rendered. */
  onCloseAutoFocus?: (event: Event) => void;
  /** K or Up. Omit at the first record. */
  onPrevious?: () => void;
  /** J or Down. Omit at the last record. */
  onNext?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const header = useRef<HTMLElement>(null);
  // The title the panel stepped away from. Focus stays put, so the new one is announced here.
  const steppedFrom = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [animateIn] = useState(() => !stepping);
  useEffect(() => {
    stepping = false;
  }, []);

  useEffect(() => {
    if (steppedFrom.current === null) return;
    const text = header.current?.querySelector("h2")?.textContent ?? "";
    if (!text || text === steppedFrom.current) return;
    steppedFrom.current = null;
    stepping = false;
    setAnnouncement(text);
  }, [title]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const key = shortcutKey(event);
    const go =
      key === "k" || key === "ArrowUp" ? onPrevious : key === "j" || key === "ArrowDown" ? onNext : undefined;
    // Up and Down at either end still scroll.
    if (!go && key !== "j" && key !== "k") return;
    event.preventDefault();
    if (!go) return;
    steppedFrom.current = header.current?.querySelector("h2")?.textContent ?? "";
    stepping = true;
    window.setTimeout(() => (stepping = false), 2000);
    go();
  }

  const steppable = Boolean(onPrevious || onNext);

  return (
    <ModalRoot open={open} onOpenChange={onOpenChange}>
      <ModalContent
        variant="sheet"
        side="bottom"
        size="full"
        showClose={false}
        padded={false}
        // The panel, not its first control: a status chip's popover would cover the header.
        initialFocus="content"
        handle
        handleClassName="md:hidden"
        animateIn={animateIn}
        onCloseAutoFocus={onCloseAutoFocus}
        onKeyDown={steppable ? onKeyDown : undefined}
        aria-describedby={description ? undefined : ""}
        className={cn(
          "max-md:top-[calc(env(safe-area-inset-top)+0.75rem)] max-md:rounded-t-3xl md:inset-6 md:mx-auto md:max-w-6xl md:rounded-3xl",
          className,
        )}
      >
        {steppable ? (
          <span aria-live="polite" className="sr-only">
            {announcement}
          </span>
        ) : null}
        <header ref={header} className="flex shrink-0 items-start gap-3 bg-background-deep px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2.5">
              {/* Wraps to two lines on phones, where there's no hover to reveal the rest. */}
              <ModalTitle className="min-w-0 break-words text-lg max-md:line-clamp-2 sm:text-xl md:truncate">
                {title}
              </ModalTitle>
              {chip}
            </div>
            {description ? (
              <ModalDescription className="mt-1 text-sm text-muted-foreground">{description}</ModalDescription>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {actions}
            <ModalClose asChild>
              <IconButton
                icon="close"
                label={closeLabel}
                tooltip={false}
                variant="bare"
                size="sm"
                className="pointer-coarse:size-11"
              />
            </ModalClose>
          </div>
        </header>

        {/* One scroll on mobile, two on desktop — a stacked sidebar that
            scrolls on its own strands half the content off-screen.
            Below md the main column sizes to its content: flex-1 with min-h-0
            in a fixed-height column lets it collapse to its padding, and the
            body disappears behind the shared scroll. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)] md:flex-row md:overflow-hidden md:pb-0">
          <div className="flex min-w-0 flex-col md:min-h-0 md:flex-1 md:overflow-hidden">
            {tabs ? <div className="shrink-0 px-5 pt-4">{tabs}</div> : null}
            <div className="p-5 md:min-h-0 md:flex-1 md:overflow-y-auto">{children}</div>
          </div>
          {sidebar ? (
            <div className="shrink-0 bg-background-deep p-5 md:min-h-0 md:w-80 md:overflow-y-auto lg:w-96">
              {sidebar}
            </div>
          ) : null}
        </div>
      </ModalContent>
    </ModalRoot>
  );
}
