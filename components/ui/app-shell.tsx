import type { AnchorHTMLAttributes, ReactNode } from "react";
import { AppShellMore } from "@/components/ui/app-shell-more";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export interface AppShellNavItem {
  label: string;
  href: string;
  icon?: IconName;
  active?: boolean;
  /** Where a client router intercepts the navigation. The kit ships plain
   * anchors so it stays framework-free. */
  onClick?: AnchorHTMLAttributes<HTMLAnchorElement>["onClick"];
}

export type AppShellOrientation = "sidebar" | "topnav";

// AppShell — the frame an app-shaped consumer hangs every screen off, in two orientations.
// "sidebar" (default) is a recessed ground rather than a bordered column (layers over borders,
// same as every other surface here). "topnav" puts the same nav items in a bar across the top
// instead. Both swap for a bottom bar under `md` so the nav stays one thumb-reach away instead
// of behind a drawer. Only one nav is ever in the accessibility tree at a given viewport —
// sidebar/topnav is an orientation choice, not a breakpoint, so exactly one of them renders at
// all, and the bottom bar takes over under `md` — so all three can share a name.
// The bottom bar holds at most five items. Past that, or with `more` content, it shows the first
// `bottomBarLimit` and a "More" item whose sheet holds the rest.
export function AppShell({
  brand,
  brandHref,
  brandLabel,
  nav,
  bottomNav,
  bottomBarLimit = 4,
  more,
  moreLabel = "More",
  navLabel = "Main",
  footer,
  accountMenu,
  topNavAccountMenu,
  topBar,
  orientation = "sidebar",
  mainId = "app-main",
  className,
  children,
}: {
  /** Product name / logo. Top of the sidebar in "sidebar", left of the nav items in "topnav" —
   * and, below `md` in either orientation, the one place the mark's destination is reachable
   * at all, since neither the bottom bar nor a page's `topBar` carries it. */
  brand?: ReactNode;
  /** Link target for `brand`, wherever it renders as a link: the "topnav" bar, and the mobile
   * brand row both orientations show under `md`. Omit it and `brand` is decorative only. */
  brandHref?: string;
  /** Accessible name for `brand` when it's a link — it's icon-only, so nothing otherwise tells
   * an assistive-tech user where it goes. Falls back to `brand`'s own label (e.g. a logo's own
   * `aria-label`) when omitted, which usually names the product, not the destination. */
  brandLabel?: string;
  nav: AppShellNavItem[];
  /** The thumb bar's destinations under `md`, in order. Defaults to `nav`. */
  bottomNav?: AppShellNavItem[];
  /** Items the thumb bar shows before the rest move to the More sheet. */
  bottomBarLimit?: number;
  /** More sheet content below the overflow destinations: account, organization, admin. Replaces
   * `accountMenu` on the thumb bar. Close it from a non-link action with `useCloseMoreSheet`. */
  more?: ReactNode;
  moreLabel?: string;
  /** Names every nav landmark — sidebar, topnav and the bottom bar all share it. */
  navLabel?: string;
  /** Bottom of the sidebar — the signed-in user, the org. "sidebar" orientation only. */
  footer?: ReactNode;
  /** Compact stand-in for `footer` on the thumb bar, where there's no room for the full row —
   * same menu, an icon-sized trigger. Omit it and whatever `footer` holds simply isn't reachable
   * under `md`. */
  accountMenu?: ReactNode;
  /** Account menu pinned right in the "topnav" bar, full size — there's room for it there the
   * way there isn't on the thumb bar. Ignored in "sidebar", which uses `footer` instead. */
  topNavAccountMenu?: ReactNode;
  /** Top bar contents: a scope picker, a search box, page actions. Stacks below the "topnav"
   * bar when both are present — a page-level bar and the global nav are different rows. */
  topBar?: ReactNode;
  /** "sidebar": left sidebar on `md+`. "topnav": a top nav bar on `md+` instead. Both keep the
   * bottom thumb bar under `md`. */
  orientation?: AppShellOrientation;
  mainId?: string;
  className?: string;
  children: ReactNode;
}) {
  // Linked when `brandHref` is given (every call site that cares about the mark being clickable
  // does), plain content otherwise. One renderer for the three places the mark can appear:
  // the sidebar, the topnav bar, and the mobile-only brand row below `md`.
  function renderBrand() {
    if (!brand) return null;
    if (!brandHref) return <div className="shrink-0 p-1">{brand}</div>;
    return (
      <a
        href={brandHref}
        aria-label={brandLabel}
        className={cn(
          "squircle shrink-0 rounded-xl p-1 transition-colors hover:bg-muted pointer-coarse:grid pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:place-items-center",
          FOCUS_RING,
        )}
      >
        {brand}
      </a>
    );
  }

  const barSource = bottomNav ?? nav;
  const needsMore = Boolean(more) || barSource.length > 5;
  const barItems = needsMore ? barSource.slice(0, bottomBarLimit) : barSource;
  const overflowItems = needsMore ? barSource.slice(bottomBarLimit) : [];

  const topNavRow =
    orientation === "topnav" ? (
      // `.container` (app/styles/layout.css) both centers this row on a wide screen and
      // supplies its horizontal padding — the topBar row below and `main` share it, so the
      // nav's left edge lines up with the page title under it.
      <div className="container hidden items-center gap-1 py-2 md:flex">
        {renderBrand()}
        <nav aria-label={navLabel} className="min-w-0 flex-1">
          <ul className="flex items-center gap-1">
            {nav.map((item) => (
              <li key={item.href}>
                <TopNavLink item={item} />
              </li>
            ))}
          </ul>
        </nav>
        {topNavAccountMenu ? <div className="shrink-0">{topNavAccountMenu}</div> : null}
      </div>
    ) : null;

  return (
    <div className={cn("flex min-h-dvh w-full bg-background text-foreground", className)}>
      <a
        href={`#${mainId}`}
        className="sr-only rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50"
      >
        Skip to content
      </a>

      {orientation === "sidebar" ? (
        <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-6 bg-background-deep px-4 py-6 md:flex">
          {brand ? <div className="px-1">{renderBrand()}</div> : null}
          <nav aria-label={navLabel} className="min-h-0 flex-1 overflow-y-auto">
            <ul className="flex flex-col gap-0.5">
              {nav.map((item) => (
                <li key={item.href}>
                  <SidebarLink item={item} />
                </li>
              ))}
            </ul>
          </nav>
          {footer ? <div className="px-2 pt-2 text-sm text-muted-foreground">{footer}</div> : null}
        </aside>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        {brand || topNavRow || topBar ? (
          <header className="sticky top-0 z-30 flex flex-col bg-background/85 backdrop-blur-lg">
            {/* Below `md`, in both orientations: the sidebar and the topnav bar (which carry the
                mark at `md+`) are both hidden there, and neither the bottom bar nor `topBar` has
                room for it — this is the only way home on a phone. */}
            {brand ? (
              <div className="flex items-center px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-6 md:hidden">
                {renderBrand()}
              </div>
            ) : null}
            {topNavRow}
            {topBar ? (
              <div
                className={cn(
                  "container flex items-center gap-3 py-3",
                  orientation === "topnav" && "border-t border-border/60",
                )}
              >
                {topBar}
              </div>
            ) : null}
          </header>
        ) : null}
        {/* `.container` on `main` in both orientations, not only "topnav": an unconstrained
            column next to a fixed-width sidebar still runs edge-to-edge on a wide screen, the
            same problem `.container` exists to solve. The sidebar's own width isn't part of the
            centering math — `.container` centers within whatever room `main` has, same as it
            would in a page with no sidebar at all. */}
        <main id={mainId} tabIndex={-1} className="container min-w-0 flex-1 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-4 outline-none md:pb-8">
          {children}
        </main>
      </div>

      {/* Bottom bar — the same items, thumb-height, under md, plus the compact account
          trigger: neither the sidebar's footer nor the topnav's account menu mounts here,
          so this is the only way to it. */}
      <nav
        aria-label={navLabel}
        className="fixed inset-x-0 bottom-0 z-40 bg-background-deep/95 backdrop-blur-lg md:hidden"
      >
        <ul className="flex items-stretch justify-around gap-1 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] pl-[max(0.5rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))]">
          {barItems.map((item) => (
            <li key={item.href} className="min-w-0 flex-1">
              <BottomBarLink item={item} />
            </li>
          ))}
          {needsMore ? (
            <li className="min-w-0 flex-1">
              <AppShellMore label={moreLabel} items={overflowItems} active={overflowItems.some((item) => item.active)}>
                {more}
              </AppShellMore>
            </li>
          ) : accountMenu ? (
            <li className="flex min-w-0 flex-1 items-center justify-center">{accountMenu}</li>
          ) : null}
        </ul>
      </nav>
    </div>
  );
}

function SidebarLink({ item }: { item: AppShellNavItem }) {
  return (
    <a
      href={item.href}
      onClick={item.onClick}
      aria-current={item.active ? "page" : undefined}
      className={cn(
        "squircle flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors",
        FOCUS_RING,
        item.active
          ? "bg-accent text-accent-foreground"
          : "text-tertiary hover:bg-muted hover:text-foreground",
      )}
    >
      {item.icon ? <Icon name={item.icon} className="size-4 shrink-0" /> : null}
      <span className="truncate">{item.label}</span>
    </a>
  );
}

function BottomBarLink({ item }: { item: AppShellNavItem }) {
  return (
    <a
      href={item.href}
      onClick={item.onClick}
      aria-current={item.active ? "page" : undefined}
      className={cn(
        "squircle press flex min-h-11 flex-col items-center gap-1 rounded-xl px-1 py-2 text-xs font-semibold transition-colors",
        FOCUS_RING,
        item.active ? "text-primary-strong" : "text-tertiary",
      )}
    >
      {item.icon ? <Icon name={item.icon} className="size-5 shrink-0" /> : null}
      {/* Labels are one or two words and never truncate. */}
      <span className="w-full whitespace-nowrap text-center">{item.label}</span>
    </a>
  );
}

function TopNavLink({ item }: { item: AppShellNavItem }) {
  return (
    <a
      href={item.href}
      onClick={item.onClick}
      aria-current={item.active ? "page" : undefined}
      className={cn(
        "squircle flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm font-medium transition-colors",
        FOCUS_RING,
        item.active
          ? "bg-accent text-accent-foreground"
          : "text-tertiary hover:bg-muted hover:text-foreground",
      )}
    >
      {item.icon ? <Icon name={item.icon} className="size-4 shrink-0" /> : null}
      <span className="truncate">{item.label}</span>
    </a>
  );
}
