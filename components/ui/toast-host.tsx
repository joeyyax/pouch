"use client";

import * as RadixToast from "@radix-ui/react-toast";
import { useSyncExternalStore } from "react";
import { cardVariants } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import {
  dismissToast,
  getServerToasts,
  getToasts,
  subscribeToasts,
  type ToastItem,
  type ToastVariant,
} from "@/lib/toast";
import { cn } from "@/lib/utils";

// Toast — fire-and-forget notifications, called imperatively from anywhere
// via toast() (lib/toast.ts). One <ToastHost> mounted once in the root
// layout renders the whole stack; Radix owns the auto-dismiss timer, pause-
// on-hover/focus, swipe-to-dismiss, and the polite live-region announcement.
// The entrance/swipe animation is plain CSS keyed off Radix's own
// data-state/data-swipe attributes (globals.css's .toast-item).

const VARIANT_ICON: Record<ToastVariant, { name: "check" | "close"; className: string } | null> = {
  default: null,
  success: { name: "check", className: "text-success" },
  error: { name: "close", className: "text-danger" },
};

function ToastRow({ item }: { item: ToastItem }) {
  const icon = VARIANT_ICON[item.variant];
  return (
    <RadixToast.Root
      duration={item.duration}
      onOpenChange={(open) => {
        if (!open) dismissToast(item.id);
      }}
      className={cn(
        cardVariants(),
        "toast-item pointer-events-auto flex w-full items-start gap-3 rounded-2xl p-4 shadow-overlay-md",
      )}
    >
      {icon ? (
        <span className={cn("mt-0.5 grid size-5 shrink-0 place-items-center", icon.className)}>
          <Icon name={icon.name} strokeWidth={2.5} className="size-4" />
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <RadixToast.Title className="text-15 font-semibold text-foreground">{item.title}</RadixToast.Title>
        {item.description ? (
          <RadixToast.Description className="mt-0.5 text-sm text-muted-foreground">
            {item.description}
          </RadixToast.Description>
        ) : null}
      </div>
      <RadixToast.Close asChild>
        <IconButton
          icon="close"
          label="Dismiss"
          variant="bare"
          size="xs"
          className="-m-1.5 shrink-0 text-muted-foreground hover:text-foreground"
          iconClassName="size-3.5"
        />
      </RadixToast.Close>
    </RadixToast.Root>
  );
}

export function ToastHost() {
  const items = useSyncExternalStore(subscribeToasts, getToasts, getServerToasts);
  return (
    <RadixToast.Provider swipeDirection="right">
      {items.map((item) => (
        <ToastRow key={item.id} item={item} />
      ))}
      <RadixToast.Viewport className="fixed bottom-0 right-0 z-[60] m-0 flex w-full max-w-sm list-none flex-col gap-2.5 p-5 outline-none sm:p-6" />
    </RadixToast.Provider>
  );
}
