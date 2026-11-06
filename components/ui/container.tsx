import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// The one content-width recipe — every section/page wrapper renders through
// this. Vertical padding, scroll-mt, id and layout classes stay at the call
// site (same "shared recipe only" split as Card's radius/padding).
export const containerVariants = cva("mx-auto w-full px-5 sm:px-8", {
  variants: {
    width: {
      "6xl": "max-w-6xl",
      "3xl": "max-w-3xl",
    },
  },
  defaultVariants: { width: "6xl" },
});

type ContainerOwnProps<T extends ElementType> = VariantProps<typeof containerVariants> & {
  as?: T;
  className?: string;
  children?: ReactNode;
};

// Props of whatever `as` renders, minus the ones this component owns — so
// `id`/`aria-*` still pass through and a misspelled prop does not.
export type ContainerProps<T extends ElementType = "section"> = ContainerOwnProps<T> &
  Omit<ComponentPropsWithoutRef<T>, keyof ContainerOwnProps<T>>;

export function Container<T extends ElementType = "section">({
  width,
  as,
  className,
  children,
  ...props
}: ContainerProps<T>) {
  const As: ElementType = as ?? "section";
  return (
    <As className={cn(containerVariants({ width }), className)} {...props}>
      {children}
    </As>
  );
}
