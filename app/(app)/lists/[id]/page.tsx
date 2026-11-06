import { notFound } from "next/navigation";
import { ApiError } from "@/lib/api/errors";
import { MEMBERSHIP_STATUSES } from "@/lib/db/enums";
import type { MembershipStatus } from "@/lib/db/schema";
import { listDomainName } from "@/lib/dashboard/lists";
import { EMPTY_MEMBER_COUNTS, memberTotal } from "@/lib/dashboard/views/lists";
import { requireOrganization, sessionActor } from "@/lib/dashboard/session";
import { readList } from "@/lib/lists";
import { listMembers } from "@/lib/lists/members";
import { ListDetail } from "./list-detail";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

function parseStatus(value: string | undefined): MembershipStatus | undefined {
  return MEMBERSHIP_STATUSES.find((status) => status === value);
}

export default async function ListDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cursor?: string; status?: string }>;
}) {
  const [{ id }, { cursor, status: rawStatus }] = await Promise.all([params, searchParams]);
  const status = parseStatus(rawStatus);
  const session = await requireOrganization();
  const caller = { organizationId: session.organizationId, domainIds: [] as string[], actor: sessionActor(session) };

  let list;
  try {
    list = await readList(caller, id, { memberCounts: true });
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") notFound();
    throw error;
  }
  const [page, domainName] = await Promise.all([
    listMembers(caller, id, PAGE_SIZE, cursor, { status }),
    listDomainName(session.organizationId, list.domain_id),
  ]);
  const counts = list.member_counts ?? EMPTY_MEMBER_COUNTS;

  return (
    <ListDetail
      list={list}
      domainName={domainName}
      members={page.data}
      counts={counts}
      total={memberTotal(counts)}
      status={status ?? null}
      nextCursor={page.next_cursor}
      paged={Boolean(cursor)}
    />
  );
}
