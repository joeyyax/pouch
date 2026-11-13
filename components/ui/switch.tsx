"use client";

import * as RadixSwitch from "@radix-ui/react-switch";
import { cva, type VariantProps } from "class-variance-authority";
import { FORM_CONTROL_BASE } from "@/components/ui/form-control-base";
import { cn } from "@/lib/utils";

export const switchVariants = cva(
  cn("press relative inline-flex shrink-0 items-center rounded-full bg-border", FORM_CONTROL_BASE, "data-[state=checked]:bg-primary"),
  {
    variants: {
      size: {
        sm: "h-5 w-9",
        md: "h-6 w-11",
      },
    },
    defaultVariants: { size: "md" },
  },
);

export const switchThumbVariants = cva(
  "block translate-x-0.5 rounded-full bg-card shadow-card transition-transform duration-200",
  {
    variants: {
      size: {
        sm: "size-4 data-[state=checked]:translate-x-[18px]",
        md: "size-5 data-[state=checked]:translate-x-[22px]",
      },
    },
    defaultVariants: { size: "md" },
  },
);

/** `size="sm"` (20×36) is for dense lists; `md` (24×44) is the default. */
export function Switch({ className, size, ...props }: RadixSwitch.SwitchProps & VariantProps<typeof switchVariants>) {
  return (
    <RadixSwitch.Root className={cn(switchVariants({ size }), className)} {...props}>
      <RadixSwitch.Thumb className={switchThumbVariants({ size })} />
    </RadixSwitch.Root>
  );
}
