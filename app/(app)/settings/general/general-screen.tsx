import { Card } from "@/components/ui/card";
import { KeyValueList } from "@/components/ui/key-value-list";
import { Separator } from "@/components/ui/separator";
import type { OrganizationSummary, OwnerSummary } from "@/lib/dashboard/views/service";
import type { OrganizationContents } from "@/lib/organizations/delete";
import { SectionHeader } from "../../_ui/section-header";
import { DeleteOrganizationSection } from "./delete-organization-section";
import { OrganizationSettingsSection } from "./organization-settings-section";

export function GeneralScreen({
  organization,
  retentionCeiling,
  owners,
  contents,
  deleteBlocked,
  lastOrganization,
  canManage,
}: {
  organization: OrganizationSummary;
  /** The install's ceiling on body retention, in days. */
  retentionCeiling: number;
  owners: OwnerSummary[];
  contents: OrganizationContents;
  deleteBlocked: string | null;
  lastOrganization: boolean;
  canManage: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <SectionHeader title="Organization" description="Changes here apply to every domain and member." />
        <Card className="flex flex-col gap-5 p-5">
          <KeyValueList
            items={[
              { label: "Name", value: organization.name, mono: false },
              { label: "Slug", value: organization.slug, mono: true, copy: organization.slug },
              {
                label: owners.length === 1 ? "Owner" : "Owners",
                value: (
                  <span className="flex flex-col gap-1">
                    {owners.map((owner) => (
                      <span key={owner.email} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                        <span>{owner.name}</span>
                        <span className="break-all font-mono text-sm text-muted-foreground">{owner.email}</span>
                      </span>
                    ))}
                  </span>
                ),
                mono: false,
              },
            ]}
          />
          <Separator />
          <OrganizationSettingsSection organization={organization} retentionCeiling={retentionCeiling} canManage={canManage} />
        </Card>
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeader
          title="Delete organization"
          description="Removes everything it holds, here and at the provider. There's no undo and no export."
        />
        <DeleteOrganizationSection
          organization={{ id: organization.id, name: organization.name }}
          contents={contents}
          blocked={deleteBlocked}
          lastOrganization={lastOrganization}
          canManage={canManage}
        />
      </section>
    </div>
  );
}
