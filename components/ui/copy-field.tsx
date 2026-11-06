"use client";

import { IconButton } from "@/components/ui/icon-button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { announce } from "@/lib/announce";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

// The copy glyph on its own, for anywhere a value already has a home —
// a key/value row, a table cell, a header. The label carries the result and a
// live region speaks it, because the only other feedback is an icon swap. A
// refused clipboard raises a toast: the value it failed on is sometimes shown
// once, and a checkmark that lied about it can't be recovered from.
export function CopyButton({
  value,
  label = "value",
  size = "xs",
  className,
}: {
  value: string;
  /** Names what gets copied: "message id", "DKIM record". */
  label?: string;
  size?: "xs" | "sm" | "md";
  className?: string;
}) {
  const { copied, copy } = useCopyToClipboard();

  async function handleClick() {
    const ok = await copy(value);
    if (ok) {
      announce(`${label} copied`);
      return;
    }
    toast({
      title: `Couldn’t copy the ${label}`,
      description: "Your browser blocked the clipboard. Select the value and copy it by hand.",
      variant: "error",
    });
  }

  return (
    <IconButton
      icon={copied ? "check" : "copy"}
      label={copied ? `${label} copied` : `Copy ${label}`}
      variant="bare"
      size={size}
      onClick={handleClick}
      className={cn("text-muted-foreground hover:text-foreground", className)}
      iconClassName={cn("size-3.5", copied && "text-success-ink")}
    />
  );
}

// CopyField — a read-only value with its copy button. Copy is the most
// common action in an app like this, so the value and the affordance are one
// component rather than a value someone remembers to pair a button with.
// `sm` is the inline id that rides beside a title; `md` is the full-width
// DNS record value that has to survive being long.
export function CopyField({
  value,
  label = "value",
  size = "md",
  mono = true,
  className,
}: {
  value: string;
  /** Names what gets copied, for the button's accessible name. */
  label?: string;
  size?: "sm" | "md";
  /** Off for prose — a provider's rejection reason, say. */
  mono?: boolean;
  className?: string;
}) {
  if (size === "sm") {
    return (
      <span
        className={cn(
          "inline-flex max-w-full items-center gap-0.5 rounded-full bg-muted py-0.5 pl-2.5 pr-0.5 text-2xs text-muted-foreground",
          mono && "font-mono",
          className,
        )}
      >
        <span className="truncate">{value}</span>
        <CopyButton value={value} label={label} size="xs" className="size-6" />
      </span>
    );
  }

  return (
    <div
      className={cn(
        "squircle flex w-full items-center gap-2 rounded-xl bg-background-deep py-1.5 pl-3 pr-1.5",
        className,
      )}
    >
      {/* Wraps. A scrolling value is invisible at phone widths, and these
          values — DKIM records, API keys — are unbroken tokens with nowhere
          to wrap on their own. */}
      <span
        className={cn("min-w-0 flex-1 break-all py-1 text-sm text-foreground", mono && "font-mono")}
      >
        {value}
      </span>
      <CopyButton value={value} label={label} size="sm" />
    </div>
  );
}
