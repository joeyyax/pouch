"use client";

import * as RadixCheckbox from "@radix-ui/react-checkbox";
import { Icon } from "@/components/ui/icon";
import { FORM_CONTROL_BASE } from "@/components/ui/form-control-base";
import { cn } from "@/lib/utils";

// Radix owns the interaction (keyboard, indeterminate, aria) — we only
// supply the Quiet Canvas skin.
export function Checkbox({
  className,
  ...props
}: RadixCheckbox.CheckboxProps) {
  return (
    <RadixCheckbox.Root
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded-[7px] border border-border bg-background",
        FORM_CONTROL_BASE,
        "data-[state=checked]:border-primary data-[state=checked]:bg-primary",
        className,
      )}
      {...props}
    >
      {/* A dash for the mixed state. aria-checked="mixed" was already
          correct, but the check icon made a partially-selected parent look
          identical to a fully selected one. */}
      <RadixCheckbox.Indicator className="text-primary-foreground">
        <Icon
          name={props.checked === "indeterminate" ? "dash" : "check"}
          strokeWidth={3}
          className="size-3.5"
        />
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );
}
