import Link from "next/link";
import { cardVariants } from "@/components/ui/card";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";

export interface SegmentedLink {
  href: string;
  label: string;
  active: boolean;
}

/** A URL-driven choice between a few options: windows, presets, views. Links, so back and reload work. */
export function SegmentedLinks({ label, options, mono = false }: { label: string; options: SegmentedLink[]; mono?: boolean }) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(cardVariants({ variant: "recessed" }), "inline-flex w-fit max-w-full items-center gap-0.5 overflow-x-auto rounded-full p-1")}
    >
      {options.map((option) => (
        <Link
          key={option.href}
          href={option.href}
          scroll={false}
          aria-current={option.active ? "true" : undefined}
          className={cn(
            "press shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold transition-colors",
            mono ? "font-mono tabular-nums" : null,
            FOCUS_RING,
            option.active ? "bg-card text-card-foreground shadow-card" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </Link>
      ))}
    </div>
  );
}
