import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// The one card recipe — layers over borders. Every white
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
      // Brand surface — a true signal, reserved for the rare callout that
      // needs to out-rank every other card on the page (Von Restorff: it
      // only works if it stays rare). `.surface-brand` scopes the role
      // tokens to the brand ground (same trick as `dark` above) so anything
      // inside the card — a kicker, a subhead, a nested button — reads
      // correctly instead of keeping its page-calibrated color.
      brand: "surface-brand pill-card-brand",
      // Frosted-glass sibling — for anything floating OVER scrolling content
      // instead of sitting on its own ground (currently just the sticky nav,
      // nav-shell.tsx). Translucent + blurred rather than opaque, still
      // tinted from --card/--card-foreground, so a caller that also toggles
      // the `dark` class at runtime (nav-shell.tsx's tone-tracking) gets the
      // matching dark-glass tint for free — same re-scope trick as `dark`
      // above, just applied dynamically instead of statically.
      glass: "pill-card-glass",
      // Floating chrome: the .surface-hud scope on a glass surface.
      hud: "surface-hud surface",
    },
    hover: {
      true: "pill-card-hover",
    },
  },
  defaultVariants: { variant: "default" },
});

type CardOwnProps<T extends ElementType> = VariantProps<typeof cardVariants> & {
  /** Nesting depth: the radius halves from --radius-surface at each level (32, 16, 8). */
  level?: 0 | 1 | 2;
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
  level,
  as,
  className,
  children,
  ...props
}: CardProps<T>) {
  const As: ElementType = as ?? "div";
  return (
    <As
      className={cn(cardVariants({ variant, hover }), level !== undefined && "surface-level", className)}
      data-level={level}
      {...props}
    >
      {children}
    </As>
  );
}

type HeadingLevel = 2 | 3 | 4;

export function CardTitle({
  level = 2,
  className,
  ...props
}: { level?: HeadingLevel } & ComponentPropsWithoutRef<"h2">) {
  const Heading = `h${level}` as "h2" | "h3" | "h4";
  return <Heading className={cn("text-base font-semibold text-foreground", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div className={cn("mt-1 text-sm text-muted-foreground", className)} {...props} />;
}

export function CardActions({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div className={cn("flex shrink-0 flex-wrap items-center gap-2", className)} {...props} />;
}

/** A card's title row: title, optional description and actions at the end that wrap under the title when the card is narrow. */
export function CardHeader({
  title,
  description,
  actions,
  headingLevel = 2,
  className,
  ...props
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  headingLevel?: HeadingLevel;
} & Omit<ComponentPropsWithoutRef<"div">, "title" | "children">) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-3", className)} {...props}>
      {/* The 16rem basis is the width below which the actions drop to their own row. */}
      <div className="min-w-0 flex-[1_1_16rem]">
        <CardTitle level={headingLevel}>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </div>
      {actions ? <CardActions>{actions}</CardActions> : null}
    </div>
  );
}
