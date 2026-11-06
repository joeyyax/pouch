"use client";

import Link from "next/link";
import { useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { Icon } from "@/components/ui/icon";
import { PopoverContent, PopoverRoot, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { OrganizationList, type SwitcherOrganization } from "./organization-switcher";
import { SignOutButton } from "./sign-out-button";
import { ThemeSwitch } from "./theme-switch";

const MENU_LINK_CLASSES = cn(
  "squircle flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm font-medium text-tertiary transition-colors hover:bg-muted hover:text-foreground pointer-coarse:min-h-11",
  FOCUS_RING,
);

const GEAR_BUTTON_CLASSES = cn(
  "squircle shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground pointer-coarse:grid pointer-coarse:size-11 pointer-coarse:place-items-center",
  FOCUS_RING,
);

/**
 * Who you are, where you are, and what you can do here — one control. Everything the sidebar's
 * nav items are scoped by, and everything about the provider driving them, collapses into this
 * so the nav stays pure work (messages, domains, keys...) and this stays pure identity.
 *
 * No titled sections — settings live as a gear beside the two labels that scope them (profile,
 * organizations) rather than as their own menu rows, and the org list is flat and directly
 * clickable rather than wrapped in a section. Order: profile, organizations (switch, add),
 * Activity, Admin (operator-only, its own separated row), theme, sign out. Admin settings is an
 * affordance here, never the gate — `requireAdmin` guards the route itself regardless of
 * what this menu shows.
 */
export function UserMenu({
  user,
  organization,
  organizations,
  emulating,
  isAdmin,
  canCreateOrganization,
  side = "top",
  align = "start",
}: {
  user: { name: string; email: string; initials: string };
  organization: SwitcherOrganization | null;
  organizations: SwitcherOrganization[];
  emulating: boolean;
  isAdmin: boolean;
  canCreateOrganization: boolean;
  /** "top"/"start" for a sidebar footer; "bottom"/"end" for a trigger pinned top right. */
  side?: "top" | "bottom";
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "squircle flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-muted",
            FOCUS_RING,
          )}
        >
          <Avatar size="sm" fallback={user.initials} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-foreground">{user.name}</span>
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <Icon name="globe" className="size-3 shrink-0" />
              <span className="min-w-0 truncate">{organization?.name ?? "No organization"}</span>
              {/* A quiet marker: the banner on every screen is what says this loudly. */}
              {emulating ? <span className="shrink-0">· Emulating</span> : null}
            </span>
          </span>
          <Icon name="chevron" className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent label="Account menu" side={side} align={align} sideOffset={8} className="w-72 p-2">
        {/* Profile — name and email, with a gear to the one setting that scopes to the person. */}
        <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-1">
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-foreground">{user.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
          </span>
          <Link href="/user/settings" onClick={close} aria-label="User settings" className={GEAR_BUTTON_CLASSES}>
            <Icon name="settings" className="size-3.5" />
          </Link>
        </div>

        <Separator decorative={false} className="my-2" />

        {/* Organizations — flat, directly clickable; a gear to the settings that scope to
            whichever one is acting. No section wrapping switching and navigation together. */}
        <div className="flex items-center justify-between px-3 pb-1 pt-1">
          <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Organizations
          </span>
          {organization ? (
            <Link href="/settings" onClick={close} aria-label="Organization settings" className={GEAR_BUTTON_CLASSES}>
              <Icon name="settings" className="size-3.5" />
            </Link>
          ) : null}
        </div>
        <OrganizationList current={organization} organizations={organizations} canCreate={canCreateOrganization} onSwitched={close} />

        {organization ? (
          <Link href="/activity" onClick={close} className={MENU_LINK_CLASSES}>
            <Icon name="clock" className="size-4 shrink-0" />
            Activity
          </Link>
        ) : null}

        {isAdmin && (
          <>
            <Separator decorative={false} className="my-2" />
            <Link href="/admin/settings" onClick={close} className={MENU_LINK_CLASSES}>
              <Icon name="shield" className="size-4 shrink-0" />
              Admin settings
            </Link>
          </>
        )}

        <Separator decorative={false} className="my-2" />
        <ThemeSwitch />
        <Separator decorative={false} className="my-2" />
        <SignOutButton className={MENU_LINK_CLASSES} />
      </PopoverContent>
    </PopoverRoot>
  );
}
