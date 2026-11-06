"use client";

import { createContext, useContext, useState, type MouseEvent, type ReactNode } from "react";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { ModalClose, ModalContent, ModalRoot, ModalTitle, ModalTrigger } from "@/components/ui/modal";
import type { AppShellNavItem } from "@/components/ui/app-shell";
import { cn } from "@/lib/utils";

/** A 48px row for anything placed in the More sheet: a link, a button, a menu entry. */
export const SHEET_ROW_CLASSES = cn(
  "squircle flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-base font-medium text-foreground transition-colors hover:bg-muted active:bg-muted",
  FOCUS_RING,
);

const MoreSheetContext = createContext<() => void>(() => {});

/** Closes the More sheet from inside it, for an action that isn't a link. */
export function useCloseMoreSheet() {
  return useContext(MoreSheetContext);
}

// The thumb bar's last item: a button that opens a bottom sheet holding the destinations the bar
// has no room for, then whatever the app adds (account, organization, admin). Radix owns the
// focus trap, Escape and focus return to this button. Following any link inside closes it.
export function AppShellMore({
  label,
  items,
  active,
  children,
}: {
  label: string;
  items: AppShellNavItem[];
  /** Lights the button when the current page is one of the sheet's destinations. */
  active: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  function closeOnLink(event: MouseEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("a[href]")) close();
  }

  return (
    <ModalRoot open={open} onOpenChange={setOpen}>
      <ModalTrigger asChild>
        <button
          type="button"
          className={cn(
            "squircle press flex min-h-11 w-full flex-col items-center gap-1 rounded-xl px-1 py-2 text-xs font-semibold transition-colors",
            FOCUS_RING,
            active || open ? "text-primary-strong" : "text-tertiary",
          )}
        >
          <Icon name="more" strokeWidth={2.5} className="size-5 shrink-0" />
          <span className="w-full whitespace-nowrap text-center">{label}</span>
        </button>
      </ModalTrigger>
      <ModalContent
        variant="sheet"
        side="bottom"
        size="lg"
        showClose={false}
        padded={false}
        aria-describedby=""
      >
        <div className="flex shrink-0 items-center justify-between gap-3 py-2 pl-5 pr-2">
          <ModalTitle className="text-lg sm:text-lg">{label}</ModalTitle>
          <ModalClose asChild>
            <IconButton icon="close" label="Close" tooltip={false} variant="bare" size="lg" />
          </ModalClose>
        </div>
        <MoreSheetContext.Provider value={close}>
          {/* A click on a link bubbles here and closes the sheet; the link still navigates. */}
          <div
            onClick={closeOnLink}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-[max(1rem,env(safe-area-inset-bottom))]"
          >
            {items.length > 0 ? (
              <ul className="flex flex-col gap-0.5">
                {items.map((item) => (
                  <li key={item.href}>
                    <a
                      href={item.href}
                      onClick={item.onClick}
                      aria-current={item.active ? "page" : undefined}
                      className={cn(SHEET_ROW_CLASSES, item.active && "bg-accent text-accent-foreground hover:bg-accent")}
                    >
                      {item.icon ? <Icon name={item.icon} className="size-5 shrink-0" /> : null}
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
            {children ? (
              <div className={cn(items.length > 0 && "mt-3 border-t border-border/60 pt-3")}>{children}</div>
            ) : null}
          </div>
        </MoreSheetContext.Provider>
      </ModalContent>
    </ModalRoot>
  );
}
