"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cardVariants } from "@/components/ui/card";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";

export interface SettingsNavItem {
  href: string;
  label: string;
}

/** Route-based sections, not Radix tabs — each one is its own page, so plain links keep the
 * back button and reload working the way every other screen here does. */
export function SettingsNav({ items, label }: { items: SettingsNavItem[]; label: string }) {
  const pathname = usePathname();

  return (
    <nav
      aria-label={label}
      className={cn(
        cardVariants({ variant: "recessed" }),
        "flex items-center gap-1 overflow-x-auto rounded-full p-1",
      )}
    >
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "press shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold transition-colors",
              FOCUS_RING,
              active ? "bg-card text-card-foreground shadow-card" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
