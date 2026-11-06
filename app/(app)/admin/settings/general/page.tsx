import { readDefaultProvider, readSystemMail } from "@/lib/dashboard/admin-general";
import { settingsFile } from "@/lib/settings/file";
import { GeneralScreen } from "./general-screen";

export const dynamic = "force-dynamic";

export default async function AdminGeneralPage() {
  const [systemMail, defaultProvider] = await Promise.all([readSystemMail(), readDefaultProvider()]);
  return <GeneralScreen systemMail={systemMail} defaultProvider={defaultProvider} configFile={settingsFile().name} />;
}
