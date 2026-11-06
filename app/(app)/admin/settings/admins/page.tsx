import { requireOrganization } from "@/lib/dashboard/session";
import { listServiceAdmins } from "@/lib/dashboard/admins";
import { AdminsScreen } from "./admins-screen";

export const dynamic = "force-dynamic";

export default async function AdminsPage() {
  const session = await requireOrganization();
  const admins = await listServiceAdmins();
  return <AdminsScreen admins={admins} currentUserId={session.userId} />;
}
