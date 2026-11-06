import type { LabelHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

// The asterisk a sighted reader sees and the "(required)" a screen reader
// hears. Shared with FieldSet's legend.
export function RequiredMark() {
  return (
    <>
      <span aria-hidden className="ml-0.5 text-danger">
        *
      </span>
      <span className="sr-only"> (required)</span>
    </>
  );
}

export function Label({
  required,
  inline = false,
  className,
  children,
  ...props
}: {
  required?: boolean;
  /**
   * Sits beside its control rather than above it — a checkbox, switch or
   * radio row. Drops the bottom margin and the block display, and steps the
   * weight back so the label reads as the option rather than as a field name.
   */
  inline?: boolean;
  className?: string;
  children?: ReactNode;
} & Omit<LabelHTMLAttributes<HTMLLabelElement>, "className" | "children">) {
  return (
    <label
      className={cn(
        "text-sm text-foreground",
        inline ? "font-normal" : "mb-1.5 block font-medium",
        className,
      )}
      {...props}
    >
      {children}
      {required ? <RequiredMark /> : null}
    </label>
  );
}
