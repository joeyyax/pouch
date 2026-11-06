import type { ReactNode } from "react";
import { requireOrganization } from "@/lib/dashboard/session";
import { readOrganization } from "@/lib/organizations";
import { PageHeader } from "../_ui/page-header";
import { SettingsNav } from "../_ui/settings-nav";

export const dynamic = "force-dynamic";

const SECTIONS = [
  { href: "/settings/general", label: "General" },
  { href: "/settings/members", label: "Members" },
  { href: "/settings/sending", label: "Sending" },
];

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const session = await requireOrganization();
  const organization = await readOrganization(session.organizationId);

  return (
    <>
      <PageHeader
        title="Settings"
        description="For this organization only."
        meta={organization ? `${organization.name} · ${organization.slug}` : undefined}
      />

      <div className="flex flex-col gap-6">
        <SettingsNav items={SECTIONS} label="Settings sections" />
        {children}
      </div>
    </>
  );
}
