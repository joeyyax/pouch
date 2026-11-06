import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Inline body-copy link — the underlined treatment the privacy page's
// anchors use, extracted for reuse. Internal paths get a client-side Link;
// anything else is external and opens in a new tab.
export function TextLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const cls = cn(
    "font-semibold text-primary-strong underline underline-offset-2 transition-colors hover:text-primary",
    className,
  );
  if (href.startsWith("/")) {
    return (
      <Link href={href} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener" className={cls}>
      {children}
    </a>
  );
}
