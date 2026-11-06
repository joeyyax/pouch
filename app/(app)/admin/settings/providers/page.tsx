import { listAdminProviders, listAdminAdapters, listOrganizationOptions } from "@/lib/dashboard/admin-providers";
import { ProvidersScreen } from "./providers-screen";

export const dynamic = "force-dynamic";

export default async function ProvidersPage() {
  const [providers, organizations] = await Promise.all([listAdminProviders(), listOrganizationOptions()]);
  return <ProvidersScreen providers={providers} adapters={listAdminAdapters()} organizations={organizations} />;
}
