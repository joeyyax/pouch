import Link from "next/link";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import type { SerializedBatch } from "@/lib/bulk/serialize";
import { MESSAGE_STATUSES } from "@/lib/db/enums";
import type { MessageStatus } from "@/lib/db/schema/messages";
import { PageHeader } from "../../_ui/page-header";
import { RankedList } from "../../_ui/ranked-list";
import { SectionHeader } from "../../_ui/section-header";
import { Time } from "../../_ui/time";
import { StatusChip } from "../../_ui/status";
import { Term } from "../../_ui/term";
import { formatNumber } from "@/lib/format/number";

/** A row of the batch's message list. */
export interface BatchMessage {
  id: string;
  to: string;
  status: MessageStatus;
}

const STATUS_TONE: Record<(typeof MESSAGE_STATUSES)[number], "neutral" | "success" | "warn" | "danger"> = {
  queued: "neutral",
  sent: "neutral",
  delivered: "success",
  deferred: "warn",
  bounced: "danger",
  complained: "danger",
  failed: "danger",
};

const countOf = (count: number) => `${formatNumber(count)} ${count === 1 ? "message" : "messages"}`;

/** Only the words a reader could misread. */
function batchNote(status: (typeof MESSAGE_STATUSES)[number], count: number): string | null {
  if (status === "deferred") return `${countOf(count)} deferred: the receiving server asked to try again later. The provider keeps retrying.`;
  if (status === "complained") return `${countOf(count)} marked as spam by their recipients. Each address is now suppressed.`;
  if (status === "failed") return `${countOf(count)} couldn't be sent: the provider refused them or retries ran out.`;
  return null;
}

export function BatchDetail({ batch, messages }: { batch: SerializedBatch; messages: BatchMessage[] }) {
  const statuses = MESSAGE_STATUSES.flatMap((status) => {
    const count = batch.counts[status] ?? 0;
    if (count === 0) return [];
    const note = batchNote(status, count);
    return [{ key: status, label: note ? <Term definition={note}>{status}</Term> : status, count, tone: STATUS_TONE[status] }];
  });

  const total = statuses.reduce((sum, status) => sum + status.count, 0);

  return (
    <>
      <PageHeader
        eyebrow="Batch"
        title={batch.subject}
        meta={
          <>
            From {batch.from} to{" "}
            {batch.list_id ? (
              <Link href={`/lists/${batch.list_id}`} className="underline underline-offset-4 hover:no-underline">
                a list
              </Link>
            ) : (
              "inline recipients"
            )}
            . {formatNumber(batch.recipient_count)} sent
            {batch.skipped_count > 0 ? `, ${formatNumber(batch.skipped_count)} skipped` : null}, <Time date={new Date(batch.created_at)} />.
          </>
        }
      />

      {statuses.length === 0 && messages.length === 0 ? (
        <Card className="p-0">
          <EmptyState icon="mail" title="No messages" description="This batch didn’t produce any messages." />
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          {statuses.length > 0 ? (
            <Card className="p-6">
              <SectionHeader title="Status" />
              <div className="mt-4">
                <RankedList items={statuses} />
              </div>
            </Card>
          ) : null}

          {messages.length > 0 ? (
            <Card className="overflow-hidden p-0">
              <div className="px-5 pt-5 pb-3">
                <SectionHeader
                  title="Messages"
                  meta={
                    messages.length < total
                      ? `Latest ${formatNumber(messages.length)} of ${formatNumber(total)}.`
                      : `${formatNumber(messages.length)} ${messages.length === 1 ? "message" : "messages"}.`
                  }
                />
              </div>
              <ul className="divide-y divide-border border-t border-border">
                {messages.map((message) => (
                  <li key={message.id}>
                    <Link
                      href={`/messages/${message.id}`}
                      className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-muted/40"
                    >
                      <span className="min-w-0 truncate font-mono text-sm">{message.to}</span>
                      <StatusChip shape="dot" status={message.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      )}
    </>
  );
}
