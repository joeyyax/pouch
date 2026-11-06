import { requireOrganization } from "@/lib/dashboard/session";
import { canWriteInOrganization } from "@/lib/auth/permissions";
import { listSuppressions, readSuppressionSummary } from "@/lib/dashboard/suppressions";
import { listDomainNames } from "@/lib/dashboard/domains";
import { readSuppressionListFilters } from "@/lib/dashboard/views/suppressions";
import { SuppressionsScreen } from "./suppressions-screen";

export const dynamic = "force-dynamic";

export default async function SuppressionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireOrganization();
  const { organizationId } = session;
  const params = await searchParams;
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

  const { search = "", ...filters } = readSuppressionListFilters((name) => one(params[name]));
  const page = Number.parseInt(one(params.page), 10);
  const [results, domainNames, summary] = await Promise.all([
    listSuppressions(organizationId, { ...filters, search, page: Number.isFinite(page) ? page : 1 }, session.timeZone),
    listDomainNames(organizationId),
    readSuppressionSummary(organizationId, session.timeZone),
  ]);

  return (
    <SuppressionsScreen
      results={results}
      summary={summary}
      search={search}
      filters={filters}
      domainNames={domainNames}
      panel={one(params.state) === "add" ? "add" : one(params.state) === "import" ? "import" : null}
      canRemove={canWriteInOrganization(session.role)}
    />
  );
}
