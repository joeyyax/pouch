import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// The one card recipe — layers over borders, per Quiet Canvas. Every white
// surface and every recessed panel renders through this so they read as one
// family. Radius and padding stay at the call site (globals.css's .pill-card
// sets its own radius, but a Tailwind radius utility on top always wins —
// that's how call sites already vary rounded-2xl/3xl/full today).
export const cardVariants = cva("", {
  variants: {
    variant: {
      default: "pill-card",
      recessed: "pill-card-recessed",
      // Forces the dark-room ground onto a card regardless of the page's
      // own theme — same `.dark` scoping trick as Section's tone="dark".
      dark: "dark pill-card",
      // Cobalt surface — a true signal, reserved for the rare callout that
      // needs to out-rank every other card on the page (Von Restorff: it
      // only works if it stays rare). `.surface-brand` scopes the role
      // tokens to the cobalt ground (same trick as `dark` above) so anything
      // inside the card — a kicker, a subhead, a nested button — reads
      // correctly instead of keeping its cream-calibrated color.
      brand: "surface-brand pill-card-brand",
      // Frosted-glass sibling — for anything floating OVER scrolling content
      // instead of sitting on its own ground (currently just the sticky nav,
      // nav-shell.tsx). Translucent + blurred rather than opaque, still
      // tinted from --card/--card-foreground, so a caller that also toggles
      // the `dark` class at runtime (nav-shell.tsx's tone-tracking) gets the
      // matching dark-glass tint for free — same re-scope trick as `dark`
      // above, just applied dynamically instead of statically.
      glass: "pill-card-glass",
    },
    hover: {
      true: "pill-card-hover",
    },
  },
  defaultVariants: { variant: "default" },
});

type CardOwnProps<T extends ElementType> = VariantProps<typeof cardVariants> & {
  as?: T;
  className?: string;
  children?: ReactNode;
};

// Props of whatever `as` renders, minus the ones this component owns — so
// `as={Link} href=…` type-checks and a misspelled prop does not.
export type CardProps<T extends ElementType = "div"> = CardOwnProps<T> &
  Omit<ComponentPropsWithoutRef<T>, keyof CardOwnProps<T>>;

export function Card<T extends ElementType = "div">({
  variant,
  hover,
  as,
  className,
  children,
  ...props
}: CardProps<T>) {
  const As: ElementType = as ?? "div";
  return (
    <As className={cn(cardVariants({ variant, hover }), className)} {...props}>
      {children}
    </As>
  );
}
