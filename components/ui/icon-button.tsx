import type { ButtonHTMLAttributes, ReactNode } from "react";
import { buttonAttrs, type ButtonAxes } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// A Button circle whose required label is also its tooltip; `children` render under the icon.
export function IconButton({
  icon,
  label,
  variant = "soft",
  tone,
  depth,
  size = "md",
  press,
  strokeWidth = 2,
  filled = false,
  pressed,
  loading = false,
  tooltip = true,
  className,
  iconClassName,
  children,
  disabled,
  onClick,
  type = "button",
  ...props
}: {
  icon: IconName;
  label: string;
  size?: Exclude<ButtonAxes["size"], "none">;
  strokeWidth?: number;
  filled?: boolean;
  pressed?: boolean;
  /** Swaps the glyph for a spinner and sets aria-busy, as Button's `loading` does; the size holds. */
  loading?: boolean;
  /** Off for a button that takes focus on mount. Radix's tooltip layer sits above the dialog's
   * and swallows the first Escape, so a focused close button with a tooltip breaks Escape. */
  tooltip?: boolean;
  className?: string;
  /** Extra classes on the icon itself (e.g. a rotation) — kept separate from
   * `className` so rotating the glyph never rotates the button/its decoration. */
  iconClassName?: string;
  children?: ReactNode;
} & Omit<ButtonAxes, "shape" | "size"> &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">) {
  const { className: base, ...data } = buttonAttrs({ variant, tone, depth, size, press, shape: "circle" });
  const glyph = size === "2xs" ? "size-3" : "size-4";
  const button = (
    <button
      aria-label={label}
      aria-pressed={pressed}
      className={cn(base, className)}
      {...data}
      // Loading stays focusable and goes inert without handlers, as Button does.
      disabled={disabled}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      {...props}
      type={loading ? "button" : type}
      onClick={loading ? undefined : onClick}
    >
      {children}
      <Icon name={icon} strokeWidth={strokeWidth} filled={filled} className={cn(glyph, iconClassName)} />
      {loading ? <span aria-hidden className={cn("btn-spin", glyph)} /> : null}
    </button>
  );

  return tooltip ? <Tooltip content={label}>{button}</Tooltip> : button;
}
