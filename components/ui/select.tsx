"use client";

import * as RadixSelect from "@radix-ui/react-select";
import { cardVariants } from "@/components/ui/card";
import { fieldClasses } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export const SelectRoot = RadixSelect.Root;
export const SelectGroup = RadixSelect.Group;
export const SelectValue = RadixSelect.Value;

export function SelectTrigger({
  className,
  children,
  shape = "cozy",
  size = "lg",
  ...props
}: RadixSelect.SelectTriggerProps & {
  shape?: "cozy" | "compact" | "pill";
  size?: "sm" | "md" | "lg";
}) {
  return (
    <RadixSelect.Trigger
      className={cn(
        fieldClasses({ shape, size }),
        "flex w-full items-center justify-between gap-2 text-left data-[placeholder]:text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children}
      <RadixSelect.Icon asChild>
        <Icon name="chevron" strokeWidth={2.25} className="size-4 shrink-0 text-muted-foreground" />
      </RadixSelect.Icon>
    </RadixSelect.Trigger>
  );
}

export function SelectContent({ className, children, ...props }: RadixSelect.SelectContentProps) {
  return (
    <RadixSelect.Portal>
      <RadixSelect.Content
        position="popper"
        sideOffset={6}
        className={cn(cardVariants(), "z-50 max-h-[min(24rem,var(--radix-select-content-available-height))] overflow-hidden rounded-2xl p-1.5")}
        {...props}
      >
        <RadixSelect.Viewport className={className}>{children}</RadixSelect.Viewport>
      </RadixSelect.Content>
    </RadixSelect.Portal>
  );
}

export function SelectItem({ className, children, ...props }: RadixSelect.SelectItemProps) {
  return (
    <RadixSelect.Item
      className={cn(
        "relative flex cursor-pointer select-none items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-15 text-foreground outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        className,
      )}
      {...props}
    >
      <RadixSelect.ItemText>{children}</RadixSelect.ItemText>
      <RadixSelect.ItemIndicator>
        <Icon name="check" strokeWidth={2.5} className="size-3.5 text-primary" />
      </RadixSelect.ItemIndicator>
    </RadixSelect.Item>
  );
}

// Radix wires the group's aria-labelledby to this, so a SelectGroup wrapping
// one is named without an aria-label.
export function SelectLabel({ className, ...props }: RadixSelect.SelectLabelProps) {
  return (
    <RadixSelect.Label
      className={cn("type-kicker px-3 pb-1 pt-2.5", className)}
      {...props}
    />
  );
}

export function SelectSeparator({ className, ...props }: RadixSelect.SelectSeparatorProps) {
  return <RadixSelect.Separator className={cn("my-1.5 h-px bg-border", className)} {...props} />;
}

interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

// The common case, in one component: a flat option list. Reach for the
// SelectRoot/SelectTrigger/SelectContent/SelectItem pieces above directly
// for grouped options or custom triggers.
export function Select({
  items,
  placeholder,
  shape = "cozy",
  size = "lg",
  triggerClassName,
  id,
  invalid,
  "aria-describedby": ariaDescribedBy,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  ...props
}: RadixSelect.SelectProps & {
  items: SelectOption[];
  placeholder?: string;
  shape?: "cozy" | "compact" | "pill";
  size?: "sm" | "md" | "lg";
  triggerClassName?: string;
  id?: string;
  /** Paints the danger border and sets aria-invalid, matching Combobox and
   * MultiSelect. */
  invalid?: boolean;
  /** Points at the hint or error text. Field supplies this. */
  "aria-describedby"?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  // Every one of these has to land on the trigger by name. SelectRoot renders
  // no DOM, so anything spread onto it reaches nothing — which silently left
  // a Field hint or error unassociated with the control it describes.
  return (
    <SelectRoot {...props}>
      <SelectTrigger
        id={id}
        aria-invalid={invalid || undefined}
        aria-describedby={ariaDescribedBy}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        shape={shape}
        size={size}
        className={triggerClassName}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value} disabled={item.disabled}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}
