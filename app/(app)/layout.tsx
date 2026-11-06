import { Suspense } from "react";
import { listReachableOrganizations, requireChromeSession } from "@/lib/dashboard/session";
import { organizationCreationRefusal, readOrganization } from "@/lib/organizations";
import { isAdmin } from "@/lib/auth/admin";
import { enabledFeatures } from "@/lib/features";
import { suspensionOf } from "@/lib/suspension";
import { AppChrome } from "./app-chrome";
import { EmulationBanner } from "./emulation-banner";
import { SuspensionBanner } from "./suspension-banner";
import { TimeZoneProvider } from "./_ui/time-zone";
import { AppShortcuts } from "./_ui/shortcuts";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const chrome = await requireChromeSession();
  const session = chrome.organization;
  const [organization, reachableOrganizations, admin, suspension, features, creationRefused] = await Promise.all([
    session ? readOrganization(session.organizationId) : null,
    listReachableOrganizations(chrome.userId),
    isAdmin(chrome.userId),
    session ? suspensionOf(session.organizationId) : null,
    enabledFeatures(),
    organizationCreationRefusal(chrome.userId),
  ]);

  return (
    <Suspense>
      <TimeZoneProvider zone={chrome.timeZone}>
      <AppChrome
        user={{
          name: chrome.name,
          email: chrome.email,
          initials: chrome.name.slice(0, 2).toUpperCase(),
        }}
        organization={
          session
            ? {
                id: session.organizationId,
                name: organization?.name ?? "",
                slug: organization?.slug ?? "",
                role: session.role,
              }
            : null
        }
        reachableOrganizations={reachableOrganizations}
        emulating={Boolean(session?.emulating)}
        isAdmin={admin}
        canCreateOrganization={creationRefused === null}
        features={features}
      >
        {session?.emulating ? (
          <EmulationBanner organizationName={organization?.name ?? "this organization"} expiresAt={session.emulating.expiresAt} />
        ) : null}
        {suspension ? <SuspensionBanner suspension={suspension} zone={chrome.timeZone} /> : null}
        {children}
        <AppShortcuts />
      </AppChrome>
      </TimeZoneProvider>
    </Suspense>
  );
}
