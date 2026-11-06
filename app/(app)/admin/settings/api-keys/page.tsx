import { listAdminKeys } from "@/lib/dashboard/keys";
import { ApiKeysScreen } from "./api-keys-screen";

export const dynamic = "force-dynamic";

export default async function AdminApiKeysPage() {
  return <ApiKeysScreen keys={await listAdminKeys()} />;
}
