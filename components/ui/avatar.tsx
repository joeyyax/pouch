"use client";

import type { ReactNode } from "react";
import * as RadixAvatar from "@radix-ui/react-avatar";
import type { VariantProps } from "class-variance-authority";
import { avatarVariants } from "@/components/ui/avatar-variants";
import { cn } from "@/lib/utils";

// Avatar — the circular image-or-initials frame, lifted out of
// TestimonialCard's hand-rolled version into a reusable primitive with size
// variants. Radix's Fallback only shows after `delayMs` (avoids a flash of
// initials while a real image is still loading) and shows immediately, with
// no delay, when there's no image to attempt at all.
//
// avatarVariants itself lives in ./avatar-variants (no "use client") so
// server components can read the class recipe without crossing the
// server->client boundary this module introduces via Radix. Re-exported here
// so existing client-side importers keep working.
export { avatarVariants };

export function Avatar({
  src,
  alt = "",
  fallback,
  size,
  className,
  children,
}: VariantProps<typeof avatarVariants> & {
  src?: string;
  alt?: string;
  fallback: string;
  className?: string;
  /** Custom fallback content — a logo mark, a hand-lettered span. Wins over
   * `fallback` when present. */
  children?: ReactNode;
}) {
  return (
    <RadixAvatar.Root className={cn(avatarVariants({ size }), className)}>
      {src ? <RadixAvatar.Image src={src} alt={alt} className="size-full object-cover" /> : null}
      <RadixAvatar.Fallback delayMs={src ? 400 : 0} className="grid place-items-center">
        {children ?? fallback}
      </RadixAvatar.Fallback>
    </RadixAvatar.Root>
  );
}
