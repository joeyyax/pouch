"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { NOTICE_TONE_COLOR, NOTICE_TONE_ICON, noticeVariants, type NoticeTone } from "@/components/ui/callout";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

// Alert — a persistent inline banner (page-level notice, form-submission
// result, degraded-service warning). Distinct from Toast: this stays put
// until dismissed or its condition clears, rather than auto-expiring and
// floating over the content. Shares Callout's tone ramp/icon mapping so a
// color means the same thing whether it's a body-copy aside or a banner.

// How urgently a screen reader announces the alert, derived from tone rather
// than left to the caller. `role="status"` is implicitly polite and waits for
// a pause — right for a save confirmation, wrong for "payments are failing",
// which is the one that has to interrupt. Pass `role` to override when the
// tone and the urgency genuinely disagree.
const TONE_ROLE: Record<NoticeTone, "status" | "alert"> = {
  info: "status",
  success: "status",
  warn: "alert",
  danger: "alert",
};

export function Alert({
  tone = "info",
  title,
  children,
  action,
  dismissible = false,
  role,
  className,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  /** Trailing call to action — matches EmptyState rather than leaving the
   * caller to nest a button in `children` and own its spacing. */
  action?: ReactNode;
  dismissible?: boolean;
  /** Overrides the tone's announcement urgency (see TONE_ROLE). */
  role?: "status" | "alert";
  className?: string;
}) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div role={role ?? TONE_ROLE[tone]} className={cn(noticeVariants({ tone }), className)}>
      <Icon
        name={NOTICE_TONE_ICON[tone]}
        strokeWidth={2.25}
        className={cn("mt-0.5 size-5 shrink-0", NOTICE_TONE_COLOR[tone])}
      />
      <div className="type-body min-w-0 flex-1 text-foreground">
        {title ? <p className={cn("font-semibold", NOTICE_TONE_COLOR[tone])}>{title}</p> : null}
        {children ? <div className={title ? "mt-1" : undefined}>{children}</div> : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
      {dismissible ? (
        <IconButton
          icon="close"
          label="Dismiss"
          variant="bare"
          size="xs"
          onClick={() => setDismissed(true)}
          className="-m-1.5 shrink-0 text-muted-foreground hover:text-foreground"
        />
      ) : null}
    </div>
  );
}
