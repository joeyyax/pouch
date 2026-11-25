import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";

export type ButtonVariant = "solid" | "soft" | "ghost" | "text";
export type ButtonTone = "neutral" | "primary" | "danger" | "overlay";
export type ButtonDepth = "flat" | "raised" | "lifted";
export type ButtonSize = "2xs" | "xs" | "sm" | "md" | "lg" | "none";
export type ButtonShape = "pill" | "circle";

/** The five axes. Each renders as one data attribute that controls.css reads. */
export type ButtonAxes = {
  /** How the tone is applied: fill, tint, fill on hover only, never a fill. */
  variant?: ButtonVariant;
  /** Defaults to `primary` for solid and `neutral` otherwise. */
  tone?: ButtonTone;
  depth?: ButtonDepth;
  /** 24, 28, 36, 40, 44px. */
  size?: ButtonSize;
  shape?: ButtonShape;
  /** `tint` gives a pressed toggle the primary tint instead of rising. */
  press?: "tint";
};

/** The `.btn` class and data attributes for the axes, for markup that isn't a Button. */
export function buttonAttrs({ variant = "solid", tone, depth = "flat", size = "md", shape = "pill", press }: ButtonAxes = {}) {
  return {
    className: "btn",
    "data-variant": variant,
    "data-tone": tone ?? (variant === "solid" ? "primary" : "neutral"),
    "data-depth": depth,
    "data-size": size,
    "data-shape": shape,
    "data-press": press,
  };
}

type ButtonAsButton = ButtonAxes & {
  as?: "button";
  /** Shows a spinner and sets aria-busy and disabled; the label keeps its width. */
  loading?: boolean;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">;

type ButtonAsAnchor = ButtonAxes & {
  as: "a";
  className?: string;
  ref?: Ref<HTMLAnchorElement>;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className">;

export type ButtonProps = ButtonAsButton | ButtonAsAnchor;

export function Button(props: ButtonProps) {
  const { variant, tone, depth, size, shape, press, className, ...rest } = props;
  const { className: base, ...data } = buttonAttrs({ variant, tone, depth, size, shape, press });
  const cls = cn(base, className);
  if (rest.as === "a") {
    const { as: _as, ...anchorProps } = rest;
    return <a className={cls} {...data} {...anchorProps} />;
  }
  const { as: _as, loading, disabled, children, onClick, type = "button", ...buttonProps } = rest as ButtonAsButton;
  return (
    <button
      className={cls}
      {...data}
      // Loading stays focusable (a disabled button drops focus to <body>) and goes inert without handlers.
      disabled={disabled}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      {...buttonProps}
      type={loading ? "button" : type}
      onClick={loading ? undefined : onClick}
    >
      {loading ? (
        <>
          <span className="contents">{children}</span>
          <span aria-hidden className="btn-spin" />
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
  className,
  ...axes
}: ButtonAxes & {
  action: ActionLink;
  className?: string;
}) {
  const { label, href, ...anchorProps } = action;
  return (
    <Button as="a" href={href} className={className} {...axes} {...anchorProps}>
      {label}
    </Button>
  );
}
