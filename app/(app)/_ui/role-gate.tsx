"use client";

import { cloneElement, isValidElement, type ReactElement } from "react";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * Wraps a button-shaped element whose action the caller's role may not allow. They see it
 * disabled with a tooltip naming what's needed, instead of a button that always fails on click.
 *
 * This is the non-throwing half of the pair — the actual guard is the matching
 * `requireOrganizationWrite` or `requireOrganizationOwner` call on the server action itself;
 * never trust this alone.
 */
export function RoleGate({
  allowed,
  reason,
  children,
}: {
  allowed: boolean;
  reason: string;
  children: ReactElement<{ disabled?: boolean }>;
}) {
  if (allowed) return children;
  const disabled = isValidElement(children) ? cloneElement(children, { disabled: true }) : children;
  return (
    <Tooltip content={reason}>
      <span>{disabled}</span>
    </Tooltip>
  );
}
