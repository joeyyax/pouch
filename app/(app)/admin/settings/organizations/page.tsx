import { listOrganizationsForOperator } from "@/lib/dashboard/admin-organizations";
import { requireAdmin } from "@/lib/auth/admin";
import { listReachableOrganizations } from "@/lib/dashboard/session";
import { localPath } from "@/lib/dashboard/local-path";
import { OrganizationsScreen } from "./organizations-screen";

export const dynamic = "force-dynamic";

export default async function OrganizationsPage({ searchParams }: { searchParams: Promise<{ org?: string; next?: string }> }) {
  const session = await requireAdmin();
  const { org, next } = await searchParams;
  const [{ organizations, sharedProviders, defaultProvider, addressLimitDefaults }, memberships] = await Promise.all([
    listOrganizationsForOperator(),
    listReachableOrganizations(session.user.id),
  ]);
  return (
    <OrganizationsScreen
      organizations={organizations}
      sharedProviders={sharedProviders}
      defaultProvider={defaultProvider}
      addressLimitDefaults={addressLimitDefaults}
      memberOf={memberships.map((membership) => membership.id)}
      focus={org ? { organizationId: org, next: localPath(next) } : null}
    />
  );
}
