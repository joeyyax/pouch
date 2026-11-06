"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyButton } from "@/components/ui/copy-field";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { KeyValueList, type KeyValueItem } from "@/components/ui/key-value-list";
import {
  REASON_LABEL,
  removalConsequence,
  SUPPRESSION_HISTORY_LIMIT,
  type SuppressionDetail,
  type SuppressionHistoryItem,
} from "@/lib/dashboard/views/suppressions";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { useOpenerFocus } from "@/hooks/use-opener-focus";
import { PageHeader } from "../_ui/page-header";
import { RoleGate } from "../_ui/role-gate";
import { StatusChip } from "../_ui/status";
import { Time } from "../_ui/time";
import { useAction } from "../_ui/use-action";
import { removeSuppressionAndLeaveAction } from "./actions";

export function SuppressionDetailScreen({
  suppression,
  canRemove,
}: {
  suppression: SuppressionDetail;
  canRemove: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useOpenerFocus(heading);
  const remove = useAction(removeSuppressionAndLeaveAction);

  const historyHref = `/messages?address=${encodeURIComponent(suppression.address)}`;
  const facts: KeyValueItem[] = [
    ...(suppression.bounceType ? [{ label: "Bounce type", value: suppression.bounceType, mono: true }] : []),
    {
      label: suppression.reason === "manual" || suppression.importedFrom ? "Note" : "Provider said",
      value: suppression.detail ? (
        <span className="whitespace-pre-wrap break-words font-mono text-xs">{suppression.detail}</span>
      ) : (
        <span className="text-muted-foreground">nothing on file</span>
      ),
      ...(suppression.detail ? { copy: suppression.detail } : {}),
    },
    { label: "Source", value: sourceLabel(suppression) },
    { label: "Id", value: suppression.id, copy: suppression.id, mono: true },
  ];

  return (
    <>
      <PageHeader
        titleRef={heading}
        eyebrow="Suppressions"
        title={<span className="break-all font-mono">{suppression.address}</span>}
        status={
          <span className="flex items-center gap-2">
            <CopyButton value={suppression.address} label="address" className="shrink-0" />
            <Link
              href={`/suppressions?reason=${suppression.reason}`}
              aria-label={`Reason: ${REASON_LABEL[suppression.reason]}`}
              className={`rounded-full transition-opacity hover:opacity-75 ${FOCUS_RING}`}
            >
              <Chip tone={suppression.reason === "manual" ? "neutral" : "issue"}>{REASON_LABEL[suppression.reason]}</Chip>
            </Link>
          </span>
        }
        description="Sends to this address from any domain fail at the API until it’s removed."
        meta={
          <>
            Added <Time date={suppression.createdAt} />.
          </>
        }
        actions={
          <>
            <Button as="a" variant="secondary" size="md" href={historyHref}>
              Recent messages
            </Button>
            <RoleGate allowed={canRemove} reason="Your role doesn't let you remove a suppression.">
              <Button
                variant="danger"
                size="md"
                onClick={(event) => {
                  opener.remember(event);
                  setConfirming(true);
                }}
              >
                Remove
              </Button>
            </RoleGate>
          </>
        }
      />

      <div className="flex flex-col gap-6">
        <Card className="p-5">
          <KeyValueList items={facts} />
        </Card>

        {/* A manual add or an import has no cause beyond the source above. */}
        {hasCause(suppression) ? (
          <Card className="p-5">
            <h2 className="type-title text-base text-foreground">What caused it</h2>
            <Cause suppression={suppression} />
          </Card>
        ) : null}

        <Card className="p-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="type-title text-base text-foreground">Send history</h2>
            {suppression.historyTotal > 0 ? (
              <span className="tabular-nums text-sm text-muted-foreground">
                {suppression.historyTotal > suppression.history.length
                  ? `latest ${suppression.history.length} of ${suppression.historyTotal}`
                  : suppression.historyTotal}
              </span>
            ) : null}
          </div>
          {suppression.counts ? (
            <p className="type-body-sm mt-2 text-muted-foreground">
              <Count n={suppression.counts.bounces} one="bounce" many="bounces" />,{" "}
              <Count n={suppression.counts.complaints} one="complaint" many="complaints" />, last delivered{" "}
              {suppression.counts.lastDeliveredAt ? <Time date={suppression.counts.lastDeliveredAt} /> : "never"}.
            </p>
          ) : null}
          <MessageTable
            label={`Messages to ${suppression.address}`}
            rows={suppression.history}
            empty="No message to this address is on file."
          />
        </Card>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        onCloseAutoFocus={opener.restore}
        title={`Remove ${suppression.address}?`}
        consequence={removalConsequence(suppression.reason)}
        confirmLabel="Remove address"
        tone="destructive"
        loading={remove.pending}
        onConfirm={() => {
          const form = new FormData();
          form.set("address", suppression.address);
          remove.formAction(form);
          setConfirming(false);
        }}
        cancelLabel="Cancel"
      />
    </>
  );
}

function Count({ n, one, many }: { n: number; one: string; many: string }) {
  return (
    <span className={n > 0 ? "text-warning" : undefined}>
      {n} {n === 1 ? one : many}
    </span>
  );
}

function hasCause(suppression: SuppressionDetail): boolean {
  if (suppression.cause || suppression.incidents.length > 0) return true;
  return suppression.reason !== "manual" && !suppression.importedFrom;
}

function sourceLabel(suppression: SuppressionDetail): string {
  if (suppression.importedFrom) {
    return /import/i.test(suppression.importedFrom) ? suppression.importedFrom : `Imported from ${suppression.importedFrom}`;
  }
  if (suppression.reason === "manual") return suppression.addedBy ? `Added by ${suppression.addedBy}` : "Added by hand";
  return suppression.reason === "complaint" ? "A complaint on a send" : "A bounce on a send";
}

function Cause({ suppression }: { suppression: SuppressionDetail }) {
  const others = suppression.incidents.filter((item) => item.id !== suppression.cause?.id);

  if (!suppression.cause && others.length === 0) {
    return <p className="type-body-sm mt-3 text-muted-foreground">The message behind it is no longer on file.</p>;
  }

  return (
    <>
      {suppression.cause ? (
        <p className="type-body-sm mt-3">
          <Link href={`/messages/${suppression.cause.id}`} className="underline underline-offset-4">
            {suppression.cause.subject}
          </Link>{" "}
          <span className="text-muted-foreground">
            from {suppression.cause.domainName}, <Time date={suppression.cause.createdAt} />
          </span>
        </p>
      ) : null}
      {others.length > 0 ? (
        <>
          <p className="type-body-sm mt-3 text-muted-foreground">
            {others.length} other {others.length === 1 ? "message" : "messages"} to this address bounced or complained.
          </p>
          <MessageTable label="Other bounces and complaints" rows={others} empty="" />
        </>
      ) : null}
    </>
  );
}

function MessageTable({ label, rows, empty }: { label: string; rows: SuppressionHistoryItem[]; empty: string }) {
  const router = useRouter();
  if (rows.length === 0) return empty ? <p className="type-body-sm mt-3 text-muted-foreground">{empty}</p> : null;

  const columns: DataTableColumn<SuppressionHistoryItem>[] = [
    {
      key: "subject",
      header: "Subject",
      priority: "primary",
      cell: (row) => <span className="line-clamp-1">{row.subject}</span>,
    },
    { key: "domain", header: "Domain", cell: (row) => <span className="font-mono text-2xs">{row.domainName}</span> },
    { key: "status", header: "Status", priority: "primary", cell: (row) => <StatusChip shape="dot" status={row.status} /> },
    { key: "time", header: "When", numeric: true, cellClassName: "whitespace-nowrap", cell: (row) => <Time date={row.createdAt} /> },
  ];

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-border">
      <DataTable
        label={label}
        columns={columns}
        rows={rows.slice(0, SUPPRESSION_HISTORY_LIMIT)}
        getRowKey={(row) => row.id}
        onRowClick={(row) => router.push(`/messages/${row.id}`)}
      />
    </div>
  );
}
