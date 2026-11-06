import type { BatchRow } from "@/lib/db/schema/lists";
import type { MessageStatus } from "@/lib/db/schema";

export interface SerializedBatch {
  id: string;
  domain_id: string;
  list_id: string | null;
  from: string;
  subject: string;
  tags: string[];
  recipient_count: number;
  skipped_count: number;
  /** Message counts by lifecycle status — the live picture; recipient_count is the count at send time. */
  counts: Partial<Record<MessageStatus, number>>;
  created_at: string;
}

export function serializeBatch(batch: BatchRow, counts: Record<string, number>): SerializedBatch {
  return {
    id: batch.id,
    domain_id: batch.domainId,
    list_id: batch.listId,
    from: batch.fromAddress,
    subject: batch.subject,
    tags: batch.tags,
    recipient_count: batch.recipientCount,
    skipped_count: batch.skippedCount,
    counts,
    created_at: batch.createdAt.toISOString(),
  };
}
