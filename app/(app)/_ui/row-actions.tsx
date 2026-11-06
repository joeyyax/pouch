"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { OverflowMenu, type OverflowAction } from "./overflow-menu";
import { RoleGate } from "./role-gate";
import { ROW_ACTION } from "./row-action";

/** A row's actions: buttons on hover or focus where there's hover and room, otherwise one "…" menu. The row carries `group/row`. */
export function RowActions({ actions, label, className }: { actions: (OverflowAction | false | null | undefined)[]; label: string; className?: string }) {
  const visible = actions.filter((action): action is OverflowAction => Boolean(action));
  if (visible.length === 0) return null;
  return (
    <>
      <div className={cn("hidden flex-nowrap items-center gap-1 sm:[@media(hover:hover)]:flex", ROW_ACTION, className)}>
        {visible.filter((action) => !action.touchOnly).map((action) => (
          <RoleGate key={action.label} allowed={!action.disabled} reason={action.reason ?? ""}>
            {action.href ? (
              <Button as="a" href={action.href} variant="ghost" size="sm" download={action.download}>
                {action.label}
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={action.destructive ? "text-danger hover:text-danger" : undefined}
                onClick={(event) => {
                  event.stopPropagation();
                  action.onSelect?.(event);
                }}
              >
                {action.label}
              </Button>
            )}
          </RoleGate>
        ))}
      </div>
      <span className="shrink-0 sm:[@media(hover:hover)]:hidden" onClick={(event) => event.stopPropagation()}>
        <OverflowMenu actions={visible} label={label} />
      </span>
    </>
  );
}
