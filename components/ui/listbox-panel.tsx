"use client";

import { type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { cardVariants } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";
import type { UseListboxResult } from "@/hooks/use-listbox";
import { EASE_OUT } from "@/lib/motion";
import { cn } from "@/lib/utils";

export interface ListboxPanelOption {
  key: string;
  label: string;
  selected: boolean;
  disabled: boolean;
}

// The floated option panel Combobox and MultiSelect share: a cardVariants
// card under the input, its `<ul role="listbox">` fed by useListbox. Hand-
// floated rather than a Radix Popover so the input keeps focus while it's
// open. Real focus never enters the panel — options are only named through
// aria-activedescendant on the input.
export function ListboxPanel({
  open,
  listboxId,
  options,
  activeIndex,
  getOptionProps,
  emptyMessage,
  loading = false,
  loadingLabel = "Searching",
  multiselectable = false,
}: {
  open: boolean;
  listboxId: string;
  options: ListboxPanelOption[];
  activeIndex: number;
  getOptionProps: UseListboxResult["getOptionProps"];
  emptyMessage: ReactNode;
  loading?: boolean;
  loadingLabel?: string;
  multiselectable?: boolean;
}) {
  const reduced = useReducedMotion();
  const empty = !loading && options.length === 0;

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="listbox-panel"
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.98 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.98 }}
          transition={{ duration: 0.15, ease: EASE_OUT }}
          className="absolute inset-x-0 top-[calc(100%+0.5rem)] z-50"
        >
          {/* Skeletons and the empty message sit outside the listbox: a
              role="listbox" whose only children are presentational owns no
              option, and neither row is one. */}
          <div className={cn(cardVariants(), "max-h-64 overflow-y-auto rounded-2xl p-1.5")}>
            {loading ? (
              <SkeletonGroup label={loadingLabel} className="flex flex-col gap-1">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="mx-1.5 h-9 rounded-xl" />
                ))}
              </SkeletonGroup>
            ) : null}
            {empty ? (
              <p role="status" className="px-3 py-2.5 text-sm text-muted-foreground">
                {emptyMessage}
              </p>
            ) : null}
            <ul
              id={listboxId}
              role="listbox"
              aria-multiselectable={multiselectable || undefined}
              aria-busy={loading || undefined}
              className={loading || options.length === 0 ? "hidden" : undefined}
            >
              {options.map((opt, i) => (
                <li
                  key={opt.key}
                  {...getOptionProps(i, opt.selected)}
                  data-highlighted={i === activeIndex ? "" : undefined}
                  className={cn(
                    "flex cursor-pointer select-none items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-15 text-foreground outline-none",
                    "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
                    opt.disabled && "cursor-not-allowed opacity-45",
                  )}
                >
                  <span className="truncate">{opt.label}</span>
                  {opt.selected ? (
                    <Icon name="check" strokeWidth={2.5} className="size-3.5 shrink-0 text-primary" />
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
