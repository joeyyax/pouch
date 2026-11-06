import { requireOrganization } from "@/lib/dashboard/session";
import { listRecipients } from "@/lib/lists/recipients";
import { RecipientsScreen } from "./recipients-screen";

export const dynamic = "force-dynamic";

export default async function RecipientsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireOrganization();
  const params = await searchParams;
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";
  const search = one(params.address).trim();
  const page = Number.parseInt(one(params.page), 10);

  const results = await listRecipients(session.organizationId, { search: search || undefined, page: Number.isFinite(page) ? page : 1 });

  return <RecipientsScreen results={results} search={search} />;
}
