import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { VariantProps } from "class-variance-authority";
import { cardVariants } from "@/components/ui/card";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { Icon, type IconName } from "@/components/ui/icon";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const SIZE = {
  xs: "size-7",
  sm: "size-9",
  md: "size-10",
  lg: "size-11",
};

// IconButton — the one shape every icon-only button on the site should
// render through: a card-styled circle, a consistent touch target, the
// branded focus ring, and a Tooltip carrying the same string as the
// accessible name (so sighted mouse users get the label sighted-reader
// users already had via aria-label). `children` renders before the icon —
// room for a decoration layered under it, like a countdown ring.
// `variant="bare"` drops the card surface for a close/copy/dismiss glyph
// that sits inside another surface.
export function IconButton({
  icon,
  label,
  size = "md",
  variant = "recessed",
  strokeWidth = 2,
  filled = false,
  pressed,
  tooltip = true,
  className,
  iconClassName,
  children,
  ...props
}: {
  icon: IconName;
  label: string;
  size?: keyof typeof SIZE;
  variant?: VariantProps<typeof cardVariants>["variant"] | "bare";
  strokeWidth?: number;
  filled?: boolean;
  pressed?: boolean;
  /** Off for a button that takes focus on mount. Radix's tooltip layer sits above the dialog's
   * and swallows the first Escape, so a focused close button with a tooltip breaks Escape. */
  tooltip?: boolean;
  className?: string;
  /** Extra classes on the icon itself (e.g. a rotation) — kept separate from
   * `className` so rotating the glyph never rotates the button/its decoration. */
  iconClassName?: string;
  children?: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">) {
  const button = (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      className={cn(
        variant === "bare" ? null : cardVariants({ variant }),
        "press relative grid place-items-center rounded-full text-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        FOCUS_RING,
        SIZE[size],
        className,
      )}
      {...props}
    >
      {children}
      <Icon
        name={icon}
        strokeWidth={strokeWidth}
        filled={filled}
        className={cn("size-4", iconClassName)}
      />
    </button>
  );

  return tooltip ? <Tooltip content={label}>{button}</Tooltip> : button;
}
