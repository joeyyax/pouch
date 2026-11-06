import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";
import { cardVariants } from "@/components/ui/card";

// The one button recipe — every pill CTA on the site renders through this.
// `secondary` literally wears Card's recipe (a card-styled button, hovering
// like a card); `ghost` and `skip-link` don't take a size — their padding
// stays a per-callsite className, matching what was already true before
// this existed.
export const buttonVariants = cva(
  `press ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-50`,
  {
  variants: {
    variant: {
      primary:
        "inline-flex items-center rounded-full bg-primary font-semibold text-primary-foreground",
      secondary: cn(
        cardVariants({ hover: true }),
        "inline-flex items-center rounded-full font-semibold text-foreground",
      ),
      // The confirm on a destructive action. A plain button that reads
      // destructive — never a retype-the-name gate.
      danger:
        "inline-flex items-center rounded-full bg-danger font-semibold text-background",
      ghost:
        "rounded-full font-medium text-tertiary transition-colors hover:text-foreground",
      "skip-link":
        "sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-primary-foreground",
    },
    size: {
      sm: "px-4 py-2 text-sm",
      md: "px-5 py-2.5 text-sm",
      lg: "px-6 py-3 text-15",
      none: "",
    },
  },
  defaultVariants: { variant: "primary" },
});

type Variants = VariantProps<typeof buttonVariants>;

type ButtonAsButton = Variants & {
  as?: "button";
  /** Swaps the label for a spinner + sets aria-busy/disabled — the async
   * submit pattern already hand-rolled in contact-body.tsx, made reusable. */
  loading?: boolean;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">;

type ButtonAsAnchor = Variants & {
  as: "a";
  className?: string;
  ref?: Ref<HTMLAnchorElement>;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className">;

export function Button(props: ButtonAsButton | ButtonAsAnchor) {
  const { variant, size, className, ...rest } = props;
  const cls = cn(buttonVariants({ variant, size }), className);
  if (rest.as === "a") {
    const { as: _as, ...anchorProps } = rest;
    return <a className={cls} {...anchorProps} />;
  }
  const { as: _as, loading, disabled, children, ...buttonProps } = rest as ButtonAsButton;
  return (
    <button
      type="button"
      className={cls}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...buttonProps}
    >
      {loading ? (
        <>
          <span
            aria-hidden
            className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
          <span className="sr-only">Loading</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}

// The one `{label, href}` action shape — cta-band, hero-block, pricing, and
// comparison-table each hand-rolled this. `href` is required here so none of
// them can ship a keyboard-inoperable hrefless anchor again.
export type ActionLink = { label: ReactNode; href: string } & Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href" | "className" | "children"
>;

export function ActionButton({
  action,
  variant,
  size,
  className,
}: {
  action: ActionLink;
  variant?: Variants["variant"];
  size?: Variants["size"];
  className?: string;
}) {
  const { label, href, ...anchorProps } = action;
  return (
    <Button as="a" href={href} variant={variant} size={size} className={className} {...anchorProps}>
      {label}
    </Button>
  );
}
