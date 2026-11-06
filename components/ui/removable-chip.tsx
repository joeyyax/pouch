import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

// The selected-value token MultiSelect renders one of per chosen option —
// deliberately a size up from Chip (chip.tsx's family is text-2xs/uppercase
// status pills; this carries a real label plus an interactive remove
// target, so it reads at text-sm on a plain bg-secondary fill instead).
// Exported standalone since a token list is a reasonable thing to want
// outside a MultiSelect too (e.g. showing applied filters).
//
// Renders a bare <span> — list semantics are the caller's, so a standalone
// set of these belongs in a <ul>/<li>. Inside MultiSelect the chips sit in
// the combobox's own value area, where a list would be wrong.
export function RemovableChip({
  label,
  onRemove,
  disabled,
  className,
}: {
  label: string;
  onRemove: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full bg-secondary py-1 pl-3 pr-1 text-sm text-foreground",
        className,
      )}
    >
      {/* title so a clipped label is still readable by pointer, matching the
          full string the remove button already carries in its aria-label. */}
      <span title={label} className="truncate">
        {label}
      </span>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={`Remove ${label}`}
        className="press grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Icon name="close" strokeWidth={2.5} className="size-3" />
      </button>
    </span>
  );
}
