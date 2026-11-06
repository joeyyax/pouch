import { requireOrganization } from "@/lib/dashboard/session";
import { isOrgOwner } from "@/lib/auth/permissions";
import { readOverview } from "@/lib/dashboard/metrics";
import { readSetupState } from "@/lib/dashboard/overview-setup";
import { readSendingProvider } from "@/lib/dashboard/service";
import { KEY_PLACEHOLDER, sendSnippets } from "@/lib/dashboard/curl";
import { setupSteps } from "@/lib/dashboard/views/setup";
import { readWindowDays } from "@/lib/metrics/window";
import { OverviewScreen } from "./overview-screen";

export const dynamic = "force-dynamic";

/** The first screen after sign-in. */
export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const { organizationId, timeZone, role } = await requireOrganization();
  const { days } = await searchParams;
  const [overview, sending] = await Promise.all([
    readOverview(organizationId, readWindowDays(days), timeZone),
    readSendingProvider(organizationId),
  ]);
  const assigned = sending !== null;

  if (overview.everSentLive) return <OverviewScreen overview={overview} assigned={assigned} setup={null} canManage={isOrgOwner(role)} />;

  const state = await readSetupState(organizationId, assigned);
  return (
    <OverviewScreen
      overview={overview}
      assigned={assigned}
      setup={{
        steps: setupSteps(state),
        sendSnippets: state.verified ? sendSnippets(KEY_PLACEHOLDER, state.verified.name) : null,
      }}
    />
  );
}
