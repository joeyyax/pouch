import type { ReactNode, Ref } from "react";
import { CopyButton } from "@/components/ui/copy-field";

export function PageHeader({
  eyebrow,
  title,
  status,
  description,
  meta,
  actions,
  titleRef,
  copy,
}: {
  /** The section this screen sits in, for a screen reached from somewhere else. A label, not a link. */
  eyebrow?: ReactNode;
  title: ReactNode;
  /** Beside the title, outside the heading, so a linked chip doesn't join its accessible name. */
  status?: ReactNode;
  /**
   * Authored, stable, what this page is for. Never recomputed.
   *
   * Delete the heading and read it again: if it no longer tells you anything, it's restating the
   * title and doesn't belong. "Sends to any of them fail at the API" passes. "Manage your
   * suppressed addresses" fails.
   */
  description?: ReactNode;
  /** Derived: what's in scope, how many, over what window. Changes every render. */
  meta?: ReactNode;
  actions?: ReactNode;
  /**
   * Set on a screen that replaced the one that opened it, so focus can move here instead of
   * being left on a control that no longer exists. Adds tabIndex -1: focusable by script,
   * never in the tab order.
   */
  titleRef?: Ref<HTMLHeadingElement>;
  /** A copy button beside the title, shown on hover or focus of the title row and always on touch. Outside the heading. */
  copy?: { value: string; label: string };
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 pb-4">
      <div className="min-w-0">
        {/* type-kicker synthesizes small caps rather than uppercasing, so the announced name
            matches what was written. */}
        {eyebrow ? <p className="type-kicker mb-1">{eyebrow}</p> : null}
        {/* type-title carries no size: the kit's h-ladder starts at a
            marketing scale that dwarfs an app screen. */}
        <div className="group/title flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1
            ref={titleRef}
            {...(titleRef ? { tabIndex: -1 } : {})}
            className="type-title text-xl text-foreground outline-none sm:text-2xl"
          >
            {title}
          </h1>
          {copy ? (
            <CopyButton
              value={copy.value}
              label={copy.label}
              className="-ml-2 shrink-0 opacity-0 transition-opacity group-focus-within/title:opacity-100 group-hover/title:opacity-100 [@media(hover:none)]:opacity-100"
            />
          ) : null}
          {status}
        </div>
        {description ? (
          <p className="type-body-sm mt-1 max-w-2xl text-foreground-soft">{description}</p>
        ) : null}
        {meta ? <p className="type-body-sm mt-1 text-muted-foreground">{meta}</p> : null}
      </div>
      {actions ? <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
