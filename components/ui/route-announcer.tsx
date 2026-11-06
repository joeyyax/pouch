"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

/** The part of a path that names the section — `/messages/abc123` and `/messages` are the same section. */
export function topLevelSection(pathname: string): string {
  return `/${pathname.split("/")[1] ?? ""}`;
}

/**
 * Whether a route change should move focus and announce — only when the section itself changed.
 * `null` for `previous` means nothing has navigated yet (first render), which must stay quiet:
 * moving focus on the page the user just loaded, rather than one they navigated to, would be
 * its own bug. Two paths in the same section (a detail panel closing by navigating back to its
 * list) must also stay quiet — that path already restores focus itself.
 */
export function shouldAnnounce(previous: string | null, next: string): boolean {
  return previous !== null && previous !== next;
}

/** The label to announce for a section, falling back to the document title for an unlisted route. */
export function sectionLabel(
  section: string,
  nav: { href: string; label: string }[],
  fallback: string,
): string {
  return nav.find((item) => item.href === section)?.label ?? fallback;
}

/**
 * Moves focus to the new page's `h1` and announces its name on a route change — but only
 * between top-level sections (`/messages` -> `/domains`), never on the first load and never
 * within one (`/messages` -> `/messages/:id`).
 *
 * Every top-level screen passes its `h1` as `titleRef` to `PageHeader`, which is what makes the
 * heading focusable (`tabIndex -1`) in the first place; this only calls `.focus()` on it. `nav`
 * takes the same shape as `AppShell`'s nav items, so the two are meant to share one list.
 */
export function useRouteAnnouncer(nav: { href: string; label: string }[], mainId = "app-main") {
  const pathname = usePathname();
  const [announcement, setAnnouncement] = useState("");
  const previousSection = useRef<string | null>(null);

  useEffect(() => {
    const section = topLevelSection(pathname);
    const announce = shouldAnnounce(previousSection.current, section);
    previousSection.current = section;
    if (!announce) return;

    setAnnouncement(`${sectionLabel(section, nav, document.title)} loaded`);

    // The new segment can still be streaming in (Suspense) when this effect runs, so the
    // heading isn't guaranteed to exist on the first frame — try across a few frames rather
    // than assuming it's there.
    let attempts = 0;
    let frame: number;
    const tryFocus = () => {
      const heading = document.getElementById(mainId)?.querySelector<HTMLElement>("h1");
      if (heading) {
        heading.focus();
        return;
      }
      attempts += 1;
      if (attempts < 120) frame = requestAnimationFrame(tryFocus);
    };
    frame = requestAnimationFrame(tryFocus);
    return () => cancelAnimationFrame(frame);
  }, [pathname, nav, mainId]);

  return announcement;
}

/** Mounted once, always — a live region announces nothing until it has something to say. */
export function RouteAnnouncer({ text }: { text: string }) {
  return (
    <div role="status" aria-live="polite" className="sr-only">
      {text}
    </div>
  );
}
