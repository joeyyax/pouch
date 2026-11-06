"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface TocItem {
  id: string;
  label: string;
  /** h3 vs h2 — h3 indents one step further. */
  depth?: 2 | 3;
}

// TableOfContents — anchor-linked outline for long posts. The active-item
// highlight (via IntersectionObserver, not scroll-position math) answers
// "where am I / how much is left" as the reader scrolls — the same
// open-loop feedback the Zeigarnik Effect describes: an unresolved,
// untracked task nags at attention more than one whose progress is visible.
export function TableOfContents({
  items,
  className,
}: {
  items: TocItem[];
  className?: string;
}) {
  const [activeId, setActiveId] = useState<string | null>(items[0]?.id ?? null);

  useEffect(() => {
    const headings = items
      .map((item) => document.getElementById(item.id))
      .filter((el): el is HTMLElement => el !== null);
    if (headings.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const [first] = entries.filter((entry) => entry.isIntersecting);
        if (first) setActiveId(first.target.id);
      },
      { rootMargin: "-96px 0px -70% 0px" },
    );
    headings.forEach((heading) => observer.observe(heading));
    return () => observer.disconnect();
  }, [items]);

  if (items.length === 0) return null;

  return (
    <nav aria-label="Table of contents" className={cn("text-sm", className)}>
      <p className="type-kicker mb-3">On this page</p>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              aria-current={activeId === item.id ? "location" : undefined}
              className={cn(
                "block border-l-2 py-1 pr-2 transition-colors",
                item.depth === 3 ? "pl-7" : "pl-4",
                activeId === item.id
                  ? "border-primary font-semibold text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
