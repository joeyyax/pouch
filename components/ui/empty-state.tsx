import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

// EmptyState — icon + heading + description + optional action, for empty
// lists/search results. An empty result is often the low point of a task;
// a friendly, specific message here (not just "No results") is what the
// Peak-End Rule argues actually matters — the end of an experience shapes
// how the whole thing gets remembered.
export function EmptyState({
  icon = "search",
  title,
  titleAs: TitleTag = "p",
  description,
  children,
  action,
  className,
}: {
  icon?: IconName;
  title: string;
  /**
   * The element the title renders as. An empty state is often the only thing
   * in its region, which makes its title a de facto heading — pass the level
   * that fits the page and it joins the document outline. Stays a `p` by
   * default, since a heading in the wrong place is worse than none.
   */
  titleAs?: "p" | "h2" | "h3" | "h4";
  description?: string;
  /** Sits between the description and the action — the curl that makes the
   * first row appear, a sample payload. */
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-16 text-center", className)}>
      <div className="grid size-14 place-items-center rounded-full bg-muted text-muted-foreground">
        <Icon name={icon} className="size-6" />
      </div>
      <TitleTag className="type-display mt-5 text-xl text-foreground">{title}</TitleTag>
      {description ? (
        <p className="type-body mt-2 max-w-measure-md text-muted-foreground">{description}</p>
      ) : null}
      {children ? <div className="mt-5 w-full max-w-measure-lg text-left">{children}</div> : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}
