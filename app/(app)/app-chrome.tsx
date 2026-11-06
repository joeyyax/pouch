"use client";

import { useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { AppShell, type AppShellNavItem } from "@/components/ui/app-shell";
import { SHEET_ROW_CLASSES, useCloseMoreSheet } from "@/components/ui/app-shell-more";
import { Avatar } from "@/components/ui/avatar";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { Icon } from "@/components/ui/icon";
import { Logo } from "@/components/logo";
import type { Feature } from "@/lib/features/registry";
import { cn } from "@/lib/utils";
import { OrganizationList, type SwitcherOrganization } from "./organization-switcher";
import { RouteAnnouncer, useRouteAnnouncer } from "@/components/ui/route-announcer";
import { SignOutButton } from "./sign-out-button";
import { UserMenu } from "./user-menu";

// Activity and Settings are org-scoped, same as the switcher that drives them — they live in
// the user menu, not here. This stays pure work: the screens a member spends their day in.
//
// Overview isn't here — the brand mark is its link (`brandHref` below), in both orientations,
// so the list doesn't carry a nav item whose only job is pointing at "/". Both orientations
// read this same array; only the frame differs.
const NAV: (Omit<AppShellNavItem, "active"> & { feature?: Feature })[] = [
  { label: "Messages", href: "/messages", icon: "inbox" },
  { label: "Inbound", href: "/inbound", icon: "mail", feature: "inbound" },
  { label: "Addresses", href: "/addresses", icon: "clock", feature: "addresses" },
  { label: "Domains", href: "/domains", icon: "globe" },
  { label: "Keys", href: "/keys", icon: "key" },
  { label: "Suppressions", href: "/suppressions", icon: "block" },
  { label: "Lists", href: "/lists", icon: "list", feature: "lists" },
  { label: "Recipients", href: "/recipients", icon: "owner" },
];

// The thumb bar has no brand row to carry Overview, so it leads; the first four fit the bar and
// the rest go to More.
const BOTTOM_ORDER = ["/", "/messages", "/domains", "/keys", "/inbound", "/addresses", "/suppressions", "/lists", "/recipients"];
const OVERVIEW: Omit<AppShellNavItem, "active"> = { label: "Overview", href: "/", icon: "home" };

export function AppChrome({
  user,
  organization,
  reachableOrganizations,
  emulating,
  isAdmin,
  canCreateOrganization,
  features,
  children,
}: {
  user: { name: string; email: string; initials: string };
  /** Null for an admin with no membership: the admin screens are the only ones they reach. */
  organization: SwitcherOrganization | null;
  reachableOrganizations: SwitcherOrganization[];
  emulating: boolean;
  /** Shows the admin entries in the user menu. The affordance only — `requireAdmin` guards
   * the routes themselves, so this hiding is never the actual gate. */
  isAdmin: boolean;
  /** Shows "Add organization". `createOrganizationAction` checks it again. */
  canCreateOrganization: boolean;
  /** Which optional features are on. A screen for one that's off leaves the nav. */
  features: Record<Feature, boolean>;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const items = useMemo(() => NAV.filter((item) => !item.feature || features[item.feature]), [features]);
  const announcement = useRouteAnnouncer(items);

  // Without an acting organization every one of these screens has nothing to scope to, so the
  // frame carries the account menu and the admin section alone.
  const toNavItem = (item: Omit<AppShellNavItem, "active">): AppShellNavItem => ({
    ...item,
    active: item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`),
    onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      router.push(item.href);
    },
  });
  const nav = (organization ? items : []).map(toNavItem);
  const bottomNav = (organization ? [OVERVIEW, ...items] : [])
    .map(toNavItem)
    .sort((a, b) => BOTTOM_ORDER.indexOf(a.href) - BOTTOM_ORDER.indexOf(b.href));

  const userMenuProps = {
    user,
    organization,
    organizations: reachableOrganizations,
    emulating,
    isAdmin,
    canCreateOrganization,
  };

  return (
    <>
      <RouteAnnouncer text={announcement} />
      <AppShell
        orientation="topnav"
        brand={<Logo className="h-8 w-8" motion="hover" />}
        brandHref="/"
        // The nav list has no "Overview" entry, so the mark is the only thing that says where
        // it goes — name the destination, not the product the logo already names itself.
        brandLabel="Overview"
        nav={nav}
        bottomNav={bottomNav}
        more={<AccountSheetSection {...userMenuProps} />}
        footer={
          <div className="flex flex-col gap-3">
            <Link
              href="/reference"
              className={cn(
                "squircle flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium text-tertiary transition-colors hover:bg-muted hover:text-foreground",
                FOCUS_RING,
              )}
            >
              <Icon name="code" className="size-4 shrink-0" />
              API reference
            </Link>
            <UserMenu {...userMenuProps} />
          </div>
        }
        // Full trigger, not compact: there's room for it in the topnav bar the way there isn't
        // on the thumb bar, and unlike the thumb bar's icon-only "Account" this one still shows
        // who's signed in at a glance. It's two lines now, not three — the "Acting as" state
        // moved from a filled chip on its own line to quiet text beside the org name.
        topNavAccountMenu={<UserMenu {...userMenuProps} side="bottom" align="end" />}
      >
        {children}
      </AppShell>
    </>
  );
}

/** The user menu, laid out as rows for the More sheet. */
function AccountSheetSection({
  user,
  organization,
  organizations,
  emulating,
  isAdmin,
  canCreateOrganization,
}: {
  user: { name: string; email: string; initials: string };
  organization: SwitcherOrganization | null;
  organizations: SwitcherOrganization[];
  emulating: boolean;
  isAdmin: boolean;
  canCreateOrganization: boolean;
}) {
  const close = useCloseMoreSheet();

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-3 px-3 pb-2 pt-1">
        <Avatar size="sm" fallback={user.initials} />
        <span className="min-w-0">
          <span className="block truncate text-base font-medium text-foreground">{user.name}</span>
          <span className="block truncate text-sm text-muted-foreground">
            {user.email}
            {emulating ? " · Emulating" : null}
          </span>
        </span>
      </div>
      <Link href="/user/settings" className={SHEET_ROW_CLASSES}>
        <Icon name="settings" className="size-5 shrink-0" />
        User settings
      </Link>
      {organization ? (
        <>
          <Link href="/settings" className={SHEET_ROW_CLASSES}>
            <Icon name="settings" className="size-5 shrink-0" />
            Organization settings
          </Link>
          <Link href="/activity" className={SHEET_ROW_CLASSES}>
            <Icon name="clock" className="size-5 shrink-0" />
            Activity
          </Link>
        </>
      ) : null}
      <Link href="/reference" className={SHEET_ROW_CLASSES}>
        <Icon name="code" className="size-5 shrink-0" />
        API reference
      </Link>
      {isAdmin ? (
        <Link href="/admin/settings" className={SHEET_ROW_CLASSES}>
          <Icon name="shield" className="size-5 shrink-0" />
          Admin settings
        </Link>
      ) : null}

      <p className="mt-3 px-3 pb-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        Organizations
      </p>
      <OrganizationList current={organization} organizations={organizations} canCreate={canCreateOrganization} onSwitched={close} />

      <div className="mt-3 border-t border-border/60 pt-3">
        <SignOutButton className={SHEET_ROW_CLASSES} />
      </div>
    </div>
  );
}
