"use client";

import * as RadixRadioGroup from "@radix-ui/react-radio-group";
import { FORM_CONTROL_BASE } from "@/components/ui/form-control-base";
import { cn } from "@/lib/utils";

export const RadioGroup = RadixRadioGroup.Root;

export function RadioGroupItem({
  className,
  ...props
}: RadixRadioGroup.RadioGroupItemProps) {
  return (
    <RadixRadioGroup.Item
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded-full border border-border bg-background",
        FORM_CONTROL_BASE,
        "data-[state=checked]:border-primary",
        className,
      )}
      {...props}
    >
      <RadixRadioGroup.Indicator className="size-2.5 rounded-full bg-primary" />
    </RadixRadioGroup.Item>
  );
}
