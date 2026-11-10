"use client";

import Link from "next/link";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import type { AddressStatus } from "@/lib/addresses/constants";
import type { AddressStatusCounts } from "@/lib/addresses/manage";
import type { SerializedAddress } from "@/lib/addresses/serialize";
import { ADDRESS_STATUS_LABEL, ADDRESS_STATUS_ORDER, capTone, droppedTotal, dropReasons, type AddressCreateOptions } from "@/lib/dashboard/views/addresses";
import { formatNumber } from "@/lib/format/number";
import { cn } from "@/lib/utils";
import { CopyOnHover } from "../_ui/copy-on-hover";
import { INACTIVE_ROW } from "../_ui/inactive";
import { PageHeader } from "../_ui/page-header";
import { RowActions } from "../_ui/row-actions";
import { SegmentedLinks } from "../_ui/segmented-links";
import { Term } from "../_ui/term";
import { Time } from "../_ui/time";
import { Countdown, ExtendDialog, RevokeDialog } from "./address-ui";
import { NewAddress } from "./create-address";
import { StatusDot } from "@/components/ui/status-dot";
import { referenceUrl } from "@/lib/api-docs/links";

/** Past this share of the active limit, the screen says so. */
const NEAR_LIMIT = 0.9;

function addressesHref(query: { status?: AddressStatus | null; cursor?: string }): string {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.cursor) params.set("cursor", query.cursor);
  const suffix = params.toString();
  return suffix ? `/addresses?${suffix}` : "/addresses";
}

/** Zeros recede. */
function Count({ value, className }: { value: number; className?: string }) {
  return <span className={cn("tabular-nums", value === 0 ? "text-muted-foreground" : null, className)}>{formatNumber(value)}</span>;
}

const CAP_INK = { issue: "font-medium text-danger", warn: "font-medium text-warning", neutral: null, good: null, signal: null, info: null } as const;

export function Received({ address }: { address: SerializedAddress }) {
  const { received } = address.counts;
  if (address.message_cap === null) return <Count value={received} />;
  const tone = capTone(received, address.message_cap);
  return (
    <Term definition={`${formatNumber(received)} of its ${formatNumber(address.message_cap)}-message cap. Mail past the cap drops and counts.`}>
      <span className={cn("tabular-nums", CAP_INK[tone])}>
        {formatNumber(received)}
        <span className="text-muted-foreground"> / {formatNumber(address.message_cap)}</span>
      </span>
    </Term>
  );
}

export function Dropped({ counts }: { counts: SerializedAddress["counts"] }) {
  const total = droppedTotal(counts);
  if (total === 0) return <Count value={0} />;
  const parts = dropReasons(counts)
    .filter((part) => part.count > 0)
    .map((part) => `${formatNumber(part.count)} ${part.reason}`);
  return (
    <Term definition={`Dropped ${parts.join(", ")}.`}>
      <Count value={total} />
    </Term>
  );
}

export function AddressesScreen({
  addresses,
  counts,
  limits,
  status,
  nextCursor,
  paged,
  canManage,
  create,
}: {
  addresses: SerializedAddress[];
  counts: AddressStatusCounts;
  limits: { active: number; daily: number };
  status: AddressStatus | null;
  nextCursor: string | null;
  paged: boolean;
  canManage: boolean;
  create: AddressCreateOptions;
}) {
  const [extending, setExtending] = useState<SerializedAddress | null>(null);
  const [revoking, setRevoking] = useState<SerializedAddress | null>(null);
  const total = counts.active + counts.expired + counts.revoked;
  const atLimit = counts.active >= limits.active;
  const nearLimit = !atLimit && counts.active >= limits.active * NEAR_LIMIT;
  const denied = "Your role doesn't let you change addresses.";

  const columns: DataTableColumn<SerializedAddress>[] = [
    {
      key: "address",
      header: "Address",
      priority: "primary",
      cellClassName: "w-full max-w-0",
      cell: (address) => (
        <span className="block min-w-0">
          <CopyOnHover value={address.address} label="address" className="flex font-mono text-sm" hideOnTouch wrap>
            <Link href={`/addresses/${address.id}`} className="block break-all font-medium underline underline-offset-4 hover:no-underline sm:truncate">
              {address.address}
            </Link>
          </CopyOnHover>
          {address.label ? <span className="block truncate text-2xs text-muted-foreground">{address.label}</span> : null}
          {/* Phones drop the Status column; the countdown names the state on its own. */}
          <span className="block text-2xs text-muted-foreground sm:hidden">
            <Countdown address={address} />
          </span>
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      priority: "detail",
      cellClassName: "whitespace-nowrap",
      cell: (address) => (
        <span className="flex flex-col gap-0.5">
          <StatusDot tone={address.status === "active" ? "good" : "neutral"}>{ADDRESS_STATUS_LABEL[address.status]}</StatusDot>
          <Countdown address={address} className="text-2xs text-muted-foreground" />
        </span>
      ),
    },
    { key: "received", header: "Received", numeric: true, priority: "primary", cellClassName: "whitespace-nowrap", cell: (address) => <Received address={address} /> },
    {
      key: "dropped",
      header: <Term term="address_dropped">Dropped</Term>,
      numeric: true,
      priority: "detail",
      cell: (address) => <Dropped counts={address.counts} />,
    },
    { key: "forwarded", header: "Forwarded", numeric: true, priority: "detail", cell: (address) => <Count value={address.counts.forwarded} /> },
    {
      key: "last",
      header: "Last received",
      numeric: true,
      priority: "detail",
      cellClassName: "whitespace-nowrap",
      cell: (address) =>
        address.last_received_at ? <Time date={new Date(address.last_received_at)} /> : <span className="text-muted-foreground">Never</span>,
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      priority: "detail",
      cellClassName: "w-px whitespace-nowrap",
      cell: (address) =>
        address.status === "revoked" ? null : (
          <RowActions
            label={`Actions for ${address.address}`}
            actions={[
              {
                label: address.status === "expired" ? "Reopen" : "Extend",
                onSelect: () => setExtending(address),
                disabled: !canManage,
                reason: denied,
              },
              { label: "Revoke", onSelect: () => setRevoking(address), destructive: true, disabled: !canManage, reason: denied },
            ]}
          />
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Addresses"
        description="Addresses your keys create to receive mail, each open until it expires."
        actions={<NewAddress options={create} canManage={canManage} />}
        meta={
          <>
            {formatNumber(counts.active)} of {formatNumber(limits.active)} active.{" "}
            <Term definition="Both limits are set by an admin. Expired and revoked addresses don't count toward the active one. Mail past the daily limit drops and counts.">
              {`Up to ${formatNumber(limits.daily)} messages a day each`}
            </Term>
            .
          </>
        }
      />

      {atLimit || nearLimit ? (
        <div className="pb-4">
          <Alert tone="warn" title={atLimit ? "At the active address limit" : "Near the active address limit"}>
            {atLimit
              ? "New addresses are refused with address_limit_reached until one is revoked or expires. An admin sets the limit."
              : `${formatNumber(limits.active - counts.active)} left before new addresses are refused.`}
          </Alert>
        </div>
      ) : null}

      {total > 0 ? (
        <div className="pb-4">
          <SegmentedLinks
            label="Status"
            options={[
              { href: addressesHref({}), label: `All ${formatNumber(total)}`, active: status === null },
              ...ADDRESS_STATUS_ORDER.filter((option) => counts[option] > 0 || option === status).map((option) => ({
                href: addressesHref({ status: option }),
                label: `${ADDRESS_STATUS_LABEL[option]} ${formatNumber(counts[option])}`,
                active: option === status,
              })),
            ]}
          />
        </div>
      ) : null}

      {addresses.length === 0 && status ? (
        <EmptyState icon="mail" title={`No ${status} addresses`} description={`None of the ${formatNumber(total)} addresses are ${status}.`} />
      ) : addresses.length === 0 ? (
        <EmptyState
          icon="mail"
          title="No addresses yet"
          description="Create one with POST /v1/addresses or the create_address MCP tool. It shows up here with its countdown and counts."
          action={
            <Link href={referenceUrl({ method: "POST", path: "/v1/addresses" })} className={buttonVariants({ variant: "secondary", size: "md" })}>
              Read POST /v1/addresses
            </Link>
          }
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <DataTable
            columns={columns}
            rows={addresses}
            getRowKey={(address) => address.id}
            label="Addresses"
            rowClassName={(address) => cn("group/row", address.status === "active" ? null : INACTIVE_ROW)}
          />
        </Card>
      )}

      {paged || nextCursor ? (
        <div className="mt-4 flex items-center justify-between text-sm">
          {paged ? (
            <Link href={addressesHref({ status })} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Newest
            </Link>
          ) : (
            <span />
          )}
          {nextCursor ? (
            <Link href={addressesHref({ status, cursor: nextCursor })} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Older
            </Link>
          ) : null}
        </div>
      ) : null}

      {extending ? <ExtendDialog key={extending.id} address={extending} onClose={() => setExtending(null)} /> : null}
      <RevokeDialog address={revoking} onClose={() => setRevoking(null)} />
    </>
  );
}
