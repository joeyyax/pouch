"use client";

import * as RadixSwitch from "@radix-ui/react-switch";
import { FORM_CONTROL_BASE } from "@/components/ui/form-control-base";
import { cn } from "@/lib/utils";

export function Switch({ className, ...props }: RadixSwitch.SwitchProps) {
  return (
    <RadixSwitch.Root
      className={cn(
        "press relative inline-flex h-6 w-11 shrink-0 items-center rounded-full bg-border",
        FORM_CONTROL_BASE,
        "data-[state=checked]:bg-primary",
        className,
      )}
      {...props}
    >
      <RadixSwitch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-card shadow-card transition-transform duration-200 data-[state=checked]:translate-x-[22px]" />
    </RadixSwitch.Root>
  );
}
