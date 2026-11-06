import { requireOrganization, sessionActor } from "@/lib/dashboard/session";
import { listDomainOptions } from "@/lib/dashboard/domain-options";
import { countLists, listLists } from "@/lib/lists";
import { ListsScreen } from "./lists-screen";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function ListsPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const { cursor } = await searchParams;
  const session = await requireOrganization();
  const caller = { organizationId: session.organizationId, domainIds: [] as string[], actor: sessionActor(session) };

  const [page, total, domains] = await Promise.all([
    listLists(caller, PAGE_SIZE, cursor, {}, { memberCounts: true }),
    countLists(caller),
    listDomainOptions(session.organizationId),
  ]);
  const counts = Object.fromEntries(page.data.flatMap((list) => (list.member_counts ? [[list.id, list.member_counts]] : [])));

  return (
    <ListsScreen
      lists={page.data}
      counts={counts}
      total={total}
      nextCursor={page.next_cursor}
      paged={Boolean(cursor)}
      domains={domains}
    />
  );
}
