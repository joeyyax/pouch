import type { ReactNode } from "react";

export function SectionHeader({
  title,
  description,
  meta,
  actions,
}: {
  title: ReactNode;
  /**
   * What this section does and what changes if you use it. Same test as the page header's:
   * delete the heading and read it again. If it's restating the heading, drop it.
   *
   * A section earns one when it carries a non-obvious consequence or scope, or when its heading
   * uses a term the product invented. A heading that's a common noun over controls that describe
   * themselves doesn't.
   */
  description?: ReactNode;
  /** Derived: what's in scope, how many, over what window. */
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="type-title text-base text-foreground">{title}</h2>
        {description ? (
          <p className="type-body-sm mt-1 max-w-2xl text-foreground-soft">{description}</p>
        ) : null}
        {meta ? <p className="type-body-sm mt-1 text-muted-foreground">{meta}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
