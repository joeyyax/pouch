import type { ReactNode } from "react";
import { CopyButton } from "@/components/ui/copy-field";
import { cn } from "@/lib/utils";

export interface KeyValueItem {
  label: string;
  value: ReactNode;
  /** The string a copy button puts on the clipboard. Omit for no button. */
  copy?: string;
  /** Per-row override of the list's `mono` setting. */
  mono?: boolean;
}

// KeyValueList — the backbone of every detail panel: label on the left, the
// fact on the right, a copy button where the fact is something someone will
// paste into a support reply. A real <dl>, so a screen reader gets the
// pairing rather than two unrelated columns of text. Values are ReactNode,
// so a Chip or a link drops straight in.
export function KeyValueList({
  items,
  mono = false,
  className,
}: {
  items: KeyValueItem[];
  /** Mono values throughout — for ids, addresses, DNS records. */
  mono?: boolean;
  className?: string;
}) {
  return (
    <dl className={cn("grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-2.5 text-sm", className)}>
      {items.map((item) => {
        const isMono = item.mono ?? mono;
        return (
          <div key={item.label} className="col-span-2 grid grid-cols-subgrid items-baseline">
            <dt className="type-label pt-px text-muted-foreground">{item.label}</dt>
            <dd className="flex min-w-0 items-center gap-1">
              {/* Mono values are ids and addresses — one long token, so they
                  truncate. Anything else is prose or a chip and may wrap. */}
              <span className={cn("min-w-0 text-foreground", isMono && "truncate font-mono")}>{item.value}</span>
              {item.copy ? <CopyButton value={item.copy} label={item.label} className="shrink-0" /> : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
