import { notFound } from "next/navigation";
import { requireOrganization } from "@/lib/dashboard/session";
import { activityActors, activityFacets, readActivity } from "@/lib/activity/query";
import { activityByDay, activityWindowStart } from "@/lib/dashboard/activity-days";
import { listActivityEntries } from "@/lib/dashboard/activity-entries";
import { ActivityScreen } from "../activity-screen";
import { readActivityQuery, type SearchParams } from "../query";

export const dynamic = "force-dynamic";

export default async function ActivityDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { organizationId, timeZone } = await requireOrganization();
  const [{ id }, search] = await Promise.all([params, searchParams]);

  const open = await readActivity(organizationId, id);
  if (!open) notFound();

  const query = readActivityQuery(search);
  // The chart and the filter counts share one window.
  const since = activityWindowStart(query.filters, timeZone);
  const [{ rows, nextCursor }, facets, actors, days] = await Promise.all([
    listActivityEntries(organizationId, query.filters, timeZone, query.cursor),
    activityFacets(organizationId, since),
    activityActors(organizationId, since),
    activityByDay(organizationId, query.filters, timeZone),
  ]);

  return (
    <ActivityScreen rows={rows} nextCursor={nextCursor} query={query} facets={facets} actorOptions={actors} days={days} open={open} />
  );
}
