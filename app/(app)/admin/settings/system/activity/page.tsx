import { parseCursor, type RawParams } from "@/lib/activity/filter";
import { listServiceActivity } from "@/lib/activity/query";
import { ServiceActivityScreen } from "./service-activity-screen";

export const dynamic = "force-dynamic";

export default async function ServiceActivityPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const cursor = parseCursor(await searchParams);
  const { rows, nextCursor } = await listServiceActivity(cursor);

  return <ServiceActivityScreen rows={rows} nextCursor={nextCursor} paged={cursor !== null} />;
}
