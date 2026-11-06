import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// The small hint/error line under a field. `error` gets role="alert" so
// screen readers announce it as soon as it appears (e.g. after a failed
// client-side validation), matching the pattern already used for the
// contact form's send-failure message.
export function FieldMessage({
  id,
  tone = "hint",
  className,
  children,
}: {
  id?: string;
  tone?: "hint" | "error";
  className?: string;
  children?: ReactNode;
}) {
  return (
    <p
      id={id}
      role={tone === "error" ? "alert" : undefined}
      className={cn("mt-1.5 text-sm", tone === "error" ? "text-danger" : "text-muted-foreground", className)}
    >
      {children}
    </p>
  );
}
