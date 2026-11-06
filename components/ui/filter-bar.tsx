import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { RemovableChip } from "@/components/ui/removable-chip";
import { cn } from "@/lib/utils";

export interface FilterBarChip {
  key: string;
  label: string;
}

// FilterBar — one row that holds the controls a list is filtered by, the
// filters currently applied, and the way out of all of them. It owns no
// state: values go in, changes come out, so the caller can keep them in the
// URL where a filtered list belongs. The controls themselves are whatever
// fits — MultiSelect, Combobox, Select — passed as children.
export function FilterBar({
  label = "Filters",
  presets,
  children,
  active = [],
  onRemove,
  onClearAll,
  clearLabel = "Clear all",
  canClear,
  className,
}: {
  /** Names the group for assistive tech. */
  label?: string;
  /** One-click filter sets — "needs attention". Sits first, before the controls. */
  presets?: ReactNode;
  /** The controls. */
  children?: ReactNode;
  /** Applied filters whose own control doesn't show its value — a date
   * range, a preset, a scope inherited from elsewhere. */
  active?: FilterBarChip[];
  onRemove?: (key: string) => void;
  onClearAll?: () => void;
  clearLabel?: string;
  /** Whether anything is filtered. Defaults to "some chip is showing" — pass
   * it when a control holds a value the bar can't see. */
  canClear?: boolean;
  className?: string;
}) {
  const showClear = Boolean(onClearAll) && (canClear ?? active.length > 0);

  return (
    <div role="group" aria-label={label} className={cn("flex flex-wrap items-center gap-2", className)}>
      {presets}
      {children}
      {active.length > 0 ? (
        <ul className="flex flex-wrap items-center gap-2">
          {active.map((chip) => (
            <li key={chip.key}>
              <RemovableChip label={chip.label} onRemove={() => onRemove?.(chip.key)} />
            </li>
          ))}
        </ul>
      ) : null}
      {showClear ? (
        <Button variant="ghost" className="px-2 py-1 text-sm" onClick={onClearAll}>
          {clearLabel}
        </Button>
      ) : null}
    </div>
  );
}
