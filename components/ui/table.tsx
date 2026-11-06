import type {
  ComponentProps,
  HTMLAttributes,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";

// Table — no table styling existed anywhere on the site before this.
// Hairline row dividers plus a hover highlight give each row a visible
// boundary and make the row under the pointer unambiguous (Law of Uniform
// Connectedness: a shared line reads as "these cells belong to one row"
// more reliably than whitespace alone). Wrapped in its own scroll
// container since tables are the one layout that regularly outgrows a
// mobile viewport.
export function Table({
  className,
  label,
  children,
  ...props
}: TableHTMLAttributes<HTMLTableElement> & {
  /**
   * Names the scroll region for assistive tech. Defaults to "Table", but
   * pass what the table is about — a page with three tables otherwise
   * announces three identically-named regions.
   */
  label?: string;
}) {
  return (
    /*
     * The scroll container is focusable on purpose.
     *
     * A table wider than its column scrolls, and a scrollable box that can't
     * take focus can't be reached by a keyboard at all — the content past the
     * right edge is simply unavailable to anyone not using a pointer. The
     * container is created here rather than by the caller, so this is the only
     * place that can fix it. `role="region"` plus a name is what stops a bare
     * `tabindex` from being an unlabeled stop in the tab order.
     */
    <div
      tabIndex={0}
      role="region"
      aria-label={label ?? "Table"}
      className="w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <table className={cn("w-full border-collapse text-left text-15", className)} {...props}>
        {children}
      </table>
    </div>
  );
}

export function TableHead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("border-b border-border", className)} {...props} />;
}

export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      className={cn("group/row border-b border-border transition-colors last:border-0 hover:bg-muted/50", className)}
      {...props}
    />
  );
}

export function TableHeaderCell({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn("type-label px-4 py-3 text-muted-foreground", className)}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-4 py-3 text-foreground", className)} {...props} />;
}
