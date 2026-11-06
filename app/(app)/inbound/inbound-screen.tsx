"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Stat } from "@/components/ui/stat";
import { StatusDot, sentenceCase } from "@/components/ui/status-dot";
import type { DomainOption } from "@/lib/dashboard/inbound";
import { DELIVERY_LABEL, DELIVERY_TONE, deliveryDetail, type InboundDay, type InboundDelivery } from "@/lib/dashboard/views/inbound";
import type { SerializedInboundMessage } from "@/lib/inbound/serialize";
import { PageHeader } from "../_ui/page-header";
import { SegmentedLinks } from "../_ui/segmented-links";
import { Sparkline } from "../_ui/sparkline";
import { Term } from "../_ui/term";
import { Time } from "../_ui/time";

function inboundHref(query: { domain?: string | null; cursor?: string }): string {
  const params = new URLSearchParams();
  if (query.domain) params.set("domain", query.domain);
  if (query.cursor) params.set("cursor", query.cursor);
  const suffix = params.toString();
  return suffix ? `/inbound?${suffix}` : "/inbound";
}

function DeliveryCell({ delivery }: { delivery: InboundDelivery | undefined }) {
  if (!delivery) return <StatusDot>none</StatusDot>;
  return (
    <StatusDot tone={DELIVERY_TONE[delivery.status]} pending={delivery.status === "pending"}>
      <Term definition={deliveryDetail(delivery)}>{sentenceCase(DELIVERY_LABEL[delivery.status])}</Term>
    </StatusDot>
  );
}

export function InboundScreen({
  messages,
  nextCursor,
  paged,
  domains,
  domainId,
  daily,
  deliveries,
}: {
  messages: SerializedInboundMessage[];
  nextCursor: string | null;
  paged: boolean;
  domains: DomainOption[];
  domainId: string | null;
  daily: InboundDay[];
  deliveries: Record<string, InboundDelivery>;
}) {
  const domainName = new Map(domains.map((option) => [option.id, option.name]));
  const received = daily.reduce((sum, day) => sum + day.received, 0);
  const latest = messages[0];

  const columns: DataTableColumn<SerializedInboundMessage>[] = [
    {
      key: "from",
      header: "From",
      priority: "primary",
      cellClassName: "w-full max-w-0 sm:w-auto sm:max-w-64",
      cell: (row) => (
        <Link href={`/inbound/${row.id}`} className="block truncate font-medium underline underline-offset-4 hover:no-underline">
          {row.from}
        </Link>
      ),
    },
    {
      key: "subject",
      header: "Subject",
      priority: "detail",
      cellClassName: "w-full max-w-0",
      cell: (row) =>
        row.subject ? <span className="block truncate">{row.subject}</span> : <span className="text-muted-foreground">(no subject)</span>,
    },
    ...(domainId
      ? []
      : [
          {
            key: "domain",
            header: "Domain",
            priority: "detail" as const,
            cellClassName: "whitespace-nowrap",
            cell: (row: SerializedInboundMessage) => domainName.get(row.domain_id) ?? row.domain_id,
          },
        ]),
    {
      key: "webhook",
      header: "Webhook",
      priority: "detail",
      cellClassName: "whitespace-nowrap",
      cell: (row) => <DeliveryCell delivery={deliveries[row.id]} />,
    },
    {
      key: "received_at",
      header: "Received",
      numeric: true,
      priority: "primary",
      cellClassName: "whitespace-nowrap",
      cell: (row) => <Time date={new Date(row.received_at)} />,
    },
  ];

  return (
    <>
      <PageHeader
        title="Inbound"
        description="Mail your domains received, kept until each domain's retention runs out."
        meta={
          latest && !paged ? (
            <>
              Last received <Time date={new Date(latest.received_at)} />.
            </>
          ) : undefined
        }
      />

      {domains.length > 1 ? (
        <div className="pb-4">
          <SegmentedLinks
            label="Domain"
            options={[
              { href: inboundHref({}), label: "All domains", active: !domainId },
              ...domains.map((option) => ({ href: inboundHref({ domain: option.id }), label: option.name, active: option.id === domainId })),
            ]}
          />
        </div>
      ) : null}

      {received > 0 ? (
        <Card className="mb-6 flex flex-wrap items-end gap-x-8 gap-y-4 p-6">
          <Stat value={received} label="Received in 30 days" />
          <Sparkline
            className="h-12 min-w-48 flex-1"
            values={daily.map((day) => day.received)}
            labels={daily.map((day) => day.date.toISOString().slice(5, 10))}
            label="Received per day"
          />
        </Card>
      ) : null}

      {messages.length === 0 ? (
        <EmptyState
          icon="mail"
          title="No inbound mail yet"
          description="Turn on inbound for a verified domain and register its webhook. Mail it receives shows up here."
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <DataTable columns={columns} rows={messages} getRowKey={(row) => row.id} label="Inbound mail" />
        </Card>
      )}

      {paged || nextCursor ? (
        <div className="mt-4 flex items-center justify-between text-sm">
          {paged ? (
            <Link href={inboundHref({ domain: domainId })} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Newest
            </Link>
          ) : (
            <span />
          )}
          {nextCursor ? (
            <Link href={inboundHref({ domain: domainId, cursor: nextCursor })} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Older
            </Link>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
