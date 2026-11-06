import { cva, type VariantProps } from "class-variance-authority";

// Avatar sizing recipe, split out of avatar.tsx so server components can use
// it without crossing the server->client boundary. avatar.tsx (which has
// "use client" for Radix Avatar) re-exports this for its own consumers.
export const avatarVariants = cva(
  "grid shrink-0 place-items-center overflow-hidden rounded-full bg-muted font-semibold text-muted-foreground",
  {
    variants: {
      size: {
        sm: "size-8 text-[11px]",
        md: "size-10 text-sm",
        lg: "size-14 text-base",
      },
    },
    defaultVariants: { size: "md" },
  },
);

export type AvatarVariantProps = VariantProps<typeof avatarVariants>;
