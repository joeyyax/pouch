import { notFound } from "next/navigation";
import { ApiError } from "@/lib/api/errors";
import { selectShape } from "@/lib/api/shape";
import { requireOrganization } from "@/lib/dashboard/session";
import { batchFor, statusCounts } from "@/lib/bulk/create";
import { serializeBatch } from "@/lib/bulk/serialize";
import { LIST_LIMIT } from "@/lib/dashboard/views/messages";
import { listMessages } from "@/lib/messages/list";
import { messageListShape } from "@/lib/schemas/message";
import { BatchDetail, type BatchMessage } from "./batch-detail";

export const dynamic = "force-dynamic";

export default async function BatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireOrganization();
  const caller = { organizationId: session.organizationId, domainIds: [] as string[] };

  let data: { batch: ReturnType<typeof serializeBatch>; messages: BatchMessage[] };
  try {
    const batch = await batchFor(caller, id);
    const [counts, page] = await Promise.all([
      statusCounts(batch.id),
      listMessages(caller, LIST_LIMIT, undefined, { batch: batch.id }, selectShape(messageListShape, { fields: ["to", "status"] })),
    ]);
    const messages = page.data.map((message) => ({ id: message.id!, to: message.to?.[0] ?? "", status: message.status! }));
    data = { batch: serializeBatch(batch, counts), messages };
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") notFound();
    throw error;
  }
  return <BatchDetail batch={data.batch} messages={data.messages} />;
}
