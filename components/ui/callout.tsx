import type { ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

// Callout — a pulled-out note/warning/tip box inside body copy. Needs real
// visual distinction from the surrounding paragraph text to register at
// all (Von Restorff Effect) — a tinted background plus a tone-colored icon
// and heading, same tone ramp Chip already established (bg-danger-soft/
// text-danger, bg-warning-soft/text-warning, bg-success-soft/text-success-ink)
// so a color means the same thing everywhere on the site. Body text stays
// neutral/readable rather than tone-colored throughout — only the icon and
// title carry the tone, same as most admonition-block conventions. Overuse
// defeats the point: if every paragraph is a callout, none of them stand
// out anymore.
export const noticeVariants = cva("squircle flex gap-3 rounded-2xl p-4", {
  variants: {
    tone: {
      info: "bg-info-soft inset-ring inset-ring-info-edge",
      success: "bg-success-soft inset-ring inset-ring-success-edge",
      warn: "bg-warning-soft inset-ring inset-ring-warning-edge",
      danger: "bg-danger-soft inset-ring inset-ring-danger-edge",
    },
  },
  defaultVariants: { tone: "info" },
});

export type NoticeTone = NonNullable<VariantProps<typeof noticeVariants>["tone"]>;

export const NOTICE_TONE_COLOR: Record<NoticeTone, string> = {
  info: "text-info-ink",
  success: "text-success-ink",
  warn: "text-warning",
  danger: "text-danger",
};

export const NOTICE_TONE_ICON: Record<NoticeTone, IconName> = {
  info: "info",
  success: "check",
  warn: "warning",
  danger: "danger",
};

export function Callout({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(noticeVariants({ tone }), className)}>
      <Icon
        name={NOTICE_TONE_ICON[tone]}
        strokeWidth={2.25}
        className={cn("mt-0.5 size-5 shrink-0", NOTICE_TONE_COLOR[tone])}
      />
      <div className="type-body min-w-0 flex-1 text-foreground">
        {title ? <p className={cn("font-semibold", NOTICE_TONE_COLOR[tone])}>{title}</p> : null}
        <div className={title ? "mt-1" : undefined}>{children}</div>
      </div>
    </div>
  );
}
