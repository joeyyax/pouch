import { notFound } from "next/navigation";
import { requireOrganization } from "@/lib/dashboard/session";
import { canWriteInOrganization } from "@/lib/auth/permissions";
import { readSuppressionDetail } from "@/lib/dashboard/suppressions";
import { SuppressionDetailScreen } from "../suppression-detail";

export const dynamic = "force-dynamic";

export default async function SuppressionPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireOrganization();
  const { id } = await params;

  const suppression = await readSuppressionDetail(session.organizationId, id);
  if (!suppression) notFound();

  return <SuppressionDetailScreen suppression={suppression} canRemove={canWriteInOrganization(session.role)} />;
}
