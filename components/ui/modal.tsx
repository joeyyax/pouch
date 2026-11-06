"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import * as RadixDialog from "@radix-ui/react-dialog";
import {
  AnimatePresence,
  motion,
  useDragControls,
  useReducedMotion,
  type TargetAndTransition,
} from "framer-motion";
import { cardVariants } from "@/components/ui/card";
import { IconButton } from "@/components/ui/icon-button";
import { EASE_OUT } from "@/lib/motion";
import { track } from "@/lib/track";
import { cn } from "@/lib/utils";

// Modal — one overlay primitive, two shapes: a centered dialog for alerts
// and confirmations, or an edge-anchored sheet (`variant="sheet"` + `side`)
// for anything that wants to slide in from an edge instead. Same Radix
// Dialog foundation either way, so keyboard (Esc closes, Tab/Shift+Tab
// cycle focus inside via Radix's own focus trap — never escapes to the
// page behind it), scrolling (overflow-y-auto on the panel, body scroll
// lock while open), and mobile (widths/heights are viewport-clamped, see
// SHEET_SIZE) all come for free on both shapes, not re-implemented per
// variant. The site's three bespoke homepage sheets
// (components/sheets/sheet-host.tsx — contact/tiers/scan) stay on their
// own hand-tuned implementation — different slide direction, ground
// tones, and close-button placement — and only import DialogBackdrop/
// DialogCloseButton below for the two bits that are genuinely identical.
// This is the general-purpose version for anything new.

export const ModalTrigger = RadixDialog.Trigger;
export const ModalClose = RadixDialog.Close;

// ModalContent force-mounts its Radix parts so framer-motion owns the exit
// animation. ModalRoot publishes its open state so ModalContent can gate
// itself, rather than every caller wrapping it in AnimatePresence.
const ModalOpenContext = createContext<{ open: boolean; setOpen: (open: boolean) => void }>({
  open: false,
  setOpen: () => {},
});

/** Required ancestor of ModalContent — a plain RadixDialog.Root won't do,
 * since ModalContent reads its open state from this. */
export function ModalRoot({ children, open, defaultOpen, onOpenChange, ...props }: RadixDialog.DialogProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen ?? false);
  const isOpen = open ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (open === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  return (
    <RadixDialog.Root {...props} open={isOpen} onOpenChange={setOpen}>
      <ModalOpenContext.Provider value={{ open: isOpen, setOpen }}>{children}</ModalOpenContext.Provider>
    </RadixDialog.Root>
  );
}

export type ModalSide = "top" | "right" | "bottom" | "left";
export type ModalVariant = "center" | "sheet";
export type ModalSize = "xs" | "sm" | "md" | "lg" | "xl";
export type SheetSize = ModalSize | "full";

const CENTER_SIZE: Record<ModalSize, string> = {
  xs: "max-w-xs",
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
};

// Sheets clamp against dvh/vw, not just a fixed rem value, so a "lg" sheet
// on a small phone still fits the viewport instead of overflowing it.
const SHEET_SIZE: Record<ModalSide, Record<ModalSize, string>> = {
  top: {
    xs: "max-h-[25dvh]",
    sm: "max-h-[35dvh]",
    md: "max-h-[55dvh]",
    lg: "max-h-[85dvh]",
    xl: "max-h-[95dvh]",
  },
  bottom: {
    xs: "max-h-[25dvh]",
    sm: "max-h-[35dvh]",
    md: "max-h-[55dvh]",
    lg: "max-h-[85dvh]",
    xl: "max-h-[95dvh]",
  },
  left: {
    xs: "max-w-[min(16rem,90vw)]",
    sm: "max-w-[min(20rem,90vw)]",
    md: "max-w-[min(24rem,90vw)]",
    lg: "max-w-[min(32rem,90vw)]",
    xl: "max-w-[min(40rem,90vw)]",
  },
  right: {
    xs: "max-w-[min(16rem,90vw)]",
    sm: "max-w-[min(20rem,90vw)]",
    md: "max-w-[min(24rem,90vw)]",
    lg: "max-w-[min(32rem,90vw)]",
    xl: "max-w-[min(40rem,90vw)]",
  },
};

// Rounding only ever applies to the edge facing INTO the screen — the edge
// a sheet is anchored to (and slides in from) sits flush against the
// viewport boundary, so it's explicitly squared off rather than left to
// inherit cardVariants()'s all-corners radius.
const SHEET_POSITION: Record<ModalSide, string> = {
  top: "inset-x-0 top-0 rounded-t-none rounded-b-3xl",
  bottom: "inset-x-0 bottom-0 rounded-b-none rounded-t-3xl",
  left: "inset-y-0 left-0 h-full rounded-l-none rounded-r-3xl",
  right: "inset-y-0 right-0 h-full rounded-r-none rounded-l-3xl",
};

const SHEET_MOTION: Record<ModalSide, { hidden: TargetAndTransition; shown: TargetAndTransition }> = {
  top: { hidden: { y: "-100%" }, shown: { y: 0 } },
  bottom: { hidden: { y: "100%" }, shown: { y: 0 } },
  left: { hidden: { x: "-100%" }, shown: { x: 0 } },
  right: { hidden: { x: "100%" }, shown: { x: 0 } },
};

// Shared with components/sheets/sheet-host.tsx, which wraps its own
// RadixDialog.Overlay/Content rather than rendering <ModalContent> — the
// backdrop and close button are the only two bits truly identical between the
// two implementations, so only those get pulled out here.
export function DialogBackdrop({ animateIn = true }: { animateIn?: boolean }) {
  return (
    <motion.div
      key="backdrop"
      initial={animateIn ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="fixed inset-0 z-40 bg-scrim"
    />
  );
}

export function DialogCloseButton({
  variant = "bare",
  size = "sm",
  className,
}: Pick<ComponentProps<typeof IconButton>, "variant" | "size" | "className">) {
  return (
    <RadixDialog.Close asChild>
      <IconButton
        icon="close"
        label="Close"
        tooltip={false}
        variant={variant}
        size={size}
        className={className}
      />
    </RadixDialog.Close>
  );
}

/** Where focus lands on open: the first focusable (Radix's default), the panel itself, or an
 * element the caller names. */
export type ModalInitialFocus = "first" | "content" | RefObject<HTMLElement | null>;

// Drag past either and the sheet dismisses; short of both it springs back.
const DISMISS_OFFSET = 120;
const DISMISS_VELOCITY = 600;

export function ModalContent({
  className,
  children,
  variant = "center",
  side = "bottom",
  size = "md",
  showClose = true,
  padded = true,
  initialFocus = "first",
  handle,
  handleClassName,
  animateIn = true,
  onOpenAutoFocus,
  ...props
}: RadixDialog.DialogContentProps & {
  variant?: ModalVariant;
  side?: ModalSide;
  /** "full" only applies to variant="sheet" — fills the viewport edge to
   * edge, corners squared off on every side. */
  size?: SheetSize;
  showClose?: boolean;
  /** Off hands the whole panel to the caller: no padding, no scroll box.
   * For a layout that owns its own header and scroll regions (DetailPanel). */
  padded?: boolean;
  initialFocus?: ModalInitialFocus;
  /** A grab handle that drags the sheet down to dismiss. Bottom sheets only; on by default for
   * a bottom sheet that isn't "full". Escape and the close button stay the keyboard path. */
  handle?: boolean;
  /** Classes on the handle, e.g. `md:hidden` when the sheet only reads as one on phones. */
  handleClassName?: string;
  /** Off appears in place: for a panel replacing one just like it. Exit still animates. */
  animateIn?: boolean;
}) {
  const { open, setOpen } = useContext(ModalOpenContext);
  const reduced = useReducedMotion();
  const dragControls = useDragControls();
  const isSheet = variant === "sheet";
  const isFull = isSheet && size === "full";
  const motionVector = isSheet ? SHEET_MOTION[side] : null;
  const showHandle = isSheet && side === "bottom" && (handle ?? !isFull);

  function focusOnOpen(event: Event) {
    onOpenAutoFocus?.(event);
    if (event.defaultPrevented || initialFocus === "first") return;
    event.preventDefault();
    const target = initialFocus === "content" ? (event.currentTarget as HTMLElement) : initialFocus.current;
    target?.focus({ preventScroll: true });
  }

  const closeButton = showClose ? (
    <DialogCloseButton className="absolute right-4 top-4 text-muted-foreground hover:text-foreground" />
  ) : null;

  const inner = (
    <RadixDialog.Content asChild forceMount onOpenAutoFocus={focusOnOpen} {...props}>
      <motion.div
        key="modal-content"
        drag={showHandle ? "y" : false}
        dragListener={false}
        dragControls={dragControls}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 1 }}
        onDragEnd={(_event, info) => {
          if (info.offset.y > DISMISS_OFFSET || info.velocity.y > DISMISS_VELOCITY) setOpen(false);
        }}
        initial={!animateIn ? false : reduced ? { opacity: 0 } : isSheet ? motionVector!.hidden : { opacity: 0, scale: 0.96, y: 8 }}
        animate={reduced ? { opacity: 1 } : isSheet ? motionVector!.shown : { opacity: 1, scale: 1, y: 0 }}
        exit={reduced ? { opacity: 0 } : isSheet ? motionVector!.hidden : { opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: isSheet ? 0.45 : 0.3, ease: EASE_OUT }}
        className={cn(
          cardVariants(),
          "relative flex flex-col overflow-hidden shadow-overlay-lg outline-none",
          isSheet
            ? isFull
              ? "fixed inset-0 z-50 rounded-none"
              : cn("fixed z-50", SHEET_POSITION[side], SHEET_SIZE[side][size as ModalSize])
            : cn("w-full", CENTER_SIZE[size as ModalSize], "max-h-[85dvh] rounded-3xl"),
          className,
        )}
      >
        {showHandle ? (
          <div
            aria-hidden
            onPointerDown={(event) => dragControls.start(event)}
            className={cn(
              "absolute inset-x-0 top-0 z-10 flex h-6 cursor-grab touch-none justify-center pt-2 active:cursor-grabbing",
              handleClassName,
            )}
          >
            <span className="h-1 w-9 rounded-full bg-muted-foreground/40" />
          </div>
        ) : null}
        {closeButton}
        {/* Scroll lives here, not on the outer motion.div — the close button
            is a sibling so it stays pinned to the corner instead of
            scrolling away with the content. */}
        <div className={cn("min-h-0 flex-1", padded ? "overflow-y-auto p-6 sm:p-8" : "flex flex-col")}>
          {children}
        </div>
      </motion.div>
    </RadixDialog.Content>
  );

  return (
    <AnimatePresence>
      {open ? (
        <RadixDialog.Portal key="modal-portal" forceMount>
          <RadixDialog.Overlay asChild forceMount>
            <DialogBackdrop animateIn={animateIn} />
          </RadixDialog.Overlay>
          {isSheet ? (
            inner
          ) : (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">{inner}</div>
          )}
        </RadixDialog.Portal>
      ) : null}
    </AnimatePresence>
  );
}

export function ModalTitle({ className, ...props }: RadixDialog.DialogTitleProps) {
  return (
    <RadixDialog.Title
      className={cn("font-display text-xl font-semibold text-foreground sm:text-2xl", className)}
      {...props}
    />
  );
}

export function ModalDescription({ className, ...props }: RadixDialog.DialogDescriptionProps) {
  return (
    <RadixDialog.Description
      className={cn("mt-2 text-15 text-muted-foreground", className)}
      {...props}
    />
  );
}

// The common case: an open/onOpenChange-controlled overlay with title/
// description/footer slots. Reach for ModalRoot/ModalTrigger/ModalContent
// directly for a trigger-driven or more custom layout. Pass variant="sheet"
// (+ side) to call the exact same component as an edge-anchored sheet
// instead of a centered popup.
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  footer,
  variant,
  side,
  size,
  showClose,
  initialFocus,
  onCloseAutoFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  variant?: ModalVariant;
  side?: ModalSide;
  size?: SheetSize;
  /** Hide the corner close button. Esc and the backdrop still dismiss, so
   * give the footer a close action before turning this off. */
  showClose?: boolean;
  initialFocus?: ModalInitialFocus;
  /** Takes over where focus goes on close. Call preventDefault to keep Radix off it. */
  onCloseAutoFocus?: (event: Event) => void;
  children?: ReactNode;
}) {
  const titleLabel = typeof title === "string" ? title : undefined;
  useEffect(() => {
    if (open) track("modal_open", { variant: variant ?? "center", title: titleLabel });
  }, [open, variant, titleLabel]);

  return (
    <ModalRoot open={open} onOpenChange={onOpenChange}>
      <ModalContent
        variant={variant}
        side={side}
        size={size}
        showClose={showClose}
        initialFocus={initialFocus}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <ModalTitle>{title}</ModalTitle>
        {description ? <ModalDescription>{description}</ModalDescription> : null}
        {children ? <div className="mt-5">{children}</div> : null}
        {footer ? <div className="mt-6 flex flex-wrap justify-end gap-3">{footer}</div> : null}
      </ModalContent>
    </ModalRoot>
  );
}
