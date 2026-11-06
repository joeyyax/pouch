import type { ReactNode } from "react";
import { requireAdminPage } from "@/lib/dashboard/admin-guard";
import { SETTING_PAGES } from "@/lib/settings/registry";
import { PageHeader } from "../../_ui/page-header";
import { SettingsNav } from "../../_ui/settings-nav";

export const dynamic = "force-dynamic";

const SECTIONS = [
  { href: "/admin/settings/general", label: "General" },
  ...SETTING_PAGES.map((page) => ({ href: `/admin/settings/${page.id}`, label: page.label })),
  { href: "/admin/settings/admins", label: "Admins" },
  { href: "/admin/settings/organizations", label: "Organizations" },
  { href: "/admin/settings/providers", label: "Providers" },
  { href: "/admin/settings/api-keys", label: "API keys" },
  { href: "/admin/settings/system", label: "Status" },
];

export default async function AdminSettingsLayout({ children }: { children: ReactNode }) {
  await requireAdminPage();

  return (
    <>
      <PageHeader
        title="Admin settings"
        description="Apply across every organization."
      />

      <div className="flex flex-col gap-6">
        <SettingsNav items={SECTIONS} label="Admin settings sections" />
        {children}
      </div>
    </>
  );
}
