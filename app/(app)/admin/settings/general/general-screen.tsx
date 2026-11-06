import type { DefaultProviderView, SystemMailView } from "@/lib/dashboard/admin-general";
import { DefaultProviderCard } from "./default-provider-card";
import { ConfigFileHeader } from "./settings-sections";
import { SystemMailCard } from "./system-mail-card";

export function GeneralScreen({
  systemMail,
  defaultProvider,
  configFile,
}: {
  systemMail: SystemMailView;
  defaultProvider: DefaultProviderView;
  configFile: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <SystemMailCard view={systemMail} />
      <DefaultProviderCard view={defaultProvider} />
      <ConfigFileHeader configFile={configFile} />
    </div>
  );
}
