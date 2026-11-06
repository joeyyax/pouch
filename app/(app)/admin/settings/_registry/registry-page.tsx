import type { ReactNode } from "react";
import { accessNotes } from "@/lib/dashboard/admin-access";
import { settingsFile } from "@/lib/settings/file";
import { SETTING_SECTIONS, type SettingPage } from "@/lib/settings/registry";
import { readSettings, readSettingValues } from "@/lib/settings/values";
import { describeBodyLifecycle, describeInboundLifecycle, readBodyLifecycle, readInboundLifecycle } from "@/lib/storage/lifecycle";
import { SettingsSections, type SettingNotes } from "../general/settings-sections";

async function retentionNotes(): Promise<SettingNotes> {
  const [lifecycle, inboundLifecycle, values] = await Promise.all([readBodyLifecycle(), readInboundLifecycle(), readSettingValues()]);
  const inboundNote = describeInboundLifecycle(inboundLifecycle, values.inbound_retention_max_days);
  return {
    body_retention_max_days: describeBodyLifecycle(lifecycle, values.body_retention_max_days),
    ...(inboundNote ? { inbound_retention_max_days: inboundNote } : {}),
  };
}

const NOTES: Partial<Record<SettingPage, () => Promise<SettingNotes>>> = {
  retention: retentionNotes,
  access: accessNotes,
};

/** One Admin settings tab of registry entries, with anything else the tab holds above them. */
export async function RegistryPage({ page, children }: { page: SettingPage; children?: ReactNode }) {
  const [settings, notes] = await Promise.all([readSettings(), NOTES[page]?.() ?? {}]);
  const sections = SETTING_SECTIONS.filter((section) => section.page === page).map((section) => section.id);

  return (
    <div className="flex flex-col gap-6">
      {children}
      <SettingsSections settings={settings} notes={notes} configFile={settingsFile().name} sections={sections} />
    </div>
  );
}
