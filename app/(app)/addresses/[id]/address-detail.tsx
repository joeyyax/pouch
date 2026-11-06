"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { KeyValueList } from "@/components/ui/key-value-list";
import { StatusDot } from "@/components/ui/status-dot";
import { TextLink } from "@/components/ui/text-link";
import { ThresholdBar } from "@/components/ui/threshold-bar";
import type { SerializedForwardTarget } from "@/lib/addresses/forward-targets";
import type { SerializedAddress } from "@/lib/addresses/serialize";
import {
  ADDRESS_STATUS_LABEL,
  capTone,
  DISABLED_REASON,
  droppedTotal,
  dropReasons,
  FORWARD_STATUS_LABEL,
  FORWARD_STATUS_TONE,
  messageFlags,
} from "@/lib/dashboard/views/addresses";
import { absoluteTime, dayLabel } from "@/lib/format/time";
import { formatNumber } from "@/lib/format/number";
import type { InboundResponse } from "@/lib/inbound/serialize";
import { cn } from "@/lib/utils";
import { useOpenerFocus } from "@/hooks/use-opener-focus";
import { PageHeader } from "../../_ui/page-header";
import { RoleGate } from "../../_ui/role-gate";
import { SectionHeader } from "../../_ui/section-header";
import { Term } from "../../_ui/term";
import { Time } from "../../_ui/time";
import { useTimeZone } from "../../_ui/time-zone";
import { Countdown, ExtendDialog, RevokeDialog } from "../address-ui";

const STATUS_TERM = { active: "address_active", expired: "address_expired", revoked: "address_revoked" } as const;

/** A count against a limit: the number, then a bar when there's a limit to fill. */
function Usage({ label, value, limit, limitLabel }: { label: string; value: number; limit: number | null; limitLabel: string }) {
  const tone = capTone(value, limit);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="type-label text-muted-foreground">{label}</span>
      <span className="font-mono text-2xl font-medium tabular-nums text-foreground">
        {formatNumber(value)}
        {limit !== null ? <span className="text-base text-muted-foreground"> / {formatNumber(limit)}</span> : null}
      </span>
      {limit !== null ? (
        <ThresholdBar
          value={value}
          marks={[{ value: limit, label: limitLabel }]}
          tone={tone === "neutral" ? "neutral" : tone === "issue" ? "issue" : "warn"}
          label={`${label}: ${formatNumber(value)} of ${formatNumber(limit)}`}
        />
      ) : (
        <span className="text-2xs text-muted-foreground">No cap</span>
      )}
    </div>
  );
}

function ForwardTargetRow({ target }: { target: SerializedForwardTarget }) {
  const zone = useTimeZone();
  const detail =
    target.status === "pending" ? (
      target.confirmation_expires_at ? (
        <>
          Link sent <Time date={new Date(target.confirmation_sent_at ?? target.created_at)} />, expires {dayLabel(new Date(target.confirmation_expires_at), zone)}.
        </>
      ) : (
        "The confirmation link expired. Resend it over the API."
      )
    ) : target.status === "confirmed" ? (
      target.last_forwarded_at ? (
        <>
          {formatNumber(target.forwarded_count)} forwarded, last <Time date={new Date(target.last_forwarded_at)} />.
        </>
      ) : (
        <>
          Confirmed <Time date={new Date(target.confirmed_at ?? target.created_at)} />. Nothing forwarded yet.
        </>
      )
    ) : (
      <>
        {target.disabled_reason ? DISABLED_REASON[target.disabled_reason] : "Forwarding stopped."}
        {target.forwarded_count > 0 ? ` ${formatNumber(target.forwarded_count)} forwarded before.` : null}
      </>
    );

  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-5 py-3">
      <span className="min-w-0 flex-1">
        <span className="block break-all font-mono text-sm text-foreground">{target.email}</span>
        <span className="block text-2xs text-muted-foreground">{detail}</span>
        {target.last_failure ? (
          <span className="mt-1 block text-2xs text-warning">
            Last forward refused <Time date={new Date(target.last_failure.at)} />: {target.last_failure.message}
          </span>
        ) : null}
      </span>
      <StatusDot tone={FORWARD_STATUS_TONE[target.status]} pending={target.status === "pending"}>
        {target.status === "pending" ? <Term term="forward_pending">{FORWARD_STATUS_LABEL.pending}</Term> : FORWARD_STATUS_LABEL[target.status]}
      </StatusDot>
    </li>
  );
}

export function AddressDetail({
  address,
  messages,
  nextCursor,
  paged,
  targets,
  dailyLimit,
  keyName,
  canManage,
  forwardError,
}: {
  address: SerializedAddress;
  messages: InboundResponse[];
  nextCursor: string | null;
  paged: boolean;
  targets: SerializedForwardTarget[];
  dailyLimit: number;
  keyName: string | null;
  canManage: boolean;
  /** Why a mailbox given at creation wasn't added. */
  forwardError?: string | null;
}) {
  const zone = useTimeZone();
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useOpenerFocus(heading);
  const [extending, setExtending] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const { counts } = address;
  const dropped = droppedTotal(counts);
  const denied = "Your role doesn't let you change addresses.";
  const revoked = address.status === "revoked";
  const confirmed = targets.filter((target) => target.status === "confirmed").length;

  const columns: DataTableColumn<InboundResponse>[] = [
    {
      key: "from",
      header: "From",
      priority: "primary",
      cellClassName: "w-full max-w-0 sm:w-auto sm:max-w-64",
      cell: (message) => (
        <Link href={`/inbound/${message.id}`} className="block truncate font-medium underline underline-offset-4 hover:no-underline">
          {message.from}
        </Link>
      ),
    },
    {
      key: "subject",
      header: "Subject",
      priority: "detail",
      cellClassName: "w-full max-w-0",
      cell: (message) => (
        <span className="flex min-w-0 items-center gap-2">
          {message.subject ? <span className="truncate">{message.subject}</span> : <span className="text-muted-foreground">(no subject)</span>}
          {messageFlags(message.verdicts ?? null).map((flag) => (
            <Chip key={flag} tone="warn" className="shrink-0">
              {flag}
            </Chip>
          ))}
        </span>
      ),
    },
    {
      key: "received_at",
      header: "Received",
      numeric: true,
      priority: "primary",
      cellClassName: "whitespace-nowrap",
      cell: (message) => (message.received_at ? <Time date={new Date(message.received_at)} /> : null),
    },
  ];

  return (
    <>
      <PageHeader
        titleRef={heading}
        eyebrow="Addresses"
        title={<span className="break-all font-mono">{address.address}</span>}
        copy={{ value: address.address, label: "address" }}
        status={
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            <Term chip term={STATUS_TERM[address.status]}>
              <Chip tone={address.status === "active" ? "good" : "neutral"}>{ADDRESS_STATUS_LABEL[address.status]}</Chip>
            </Term>
            <Countdown address={address} className="type-body-sm text-muted-foreground" />
          </span>
        }
        description={address.label ?? undefined}
        meta={
          address.last_received_at ? (
            <>
              Last received <Time date={new Date(address.last_received_at)} />.
            </>
          ) : (
            undefined
          )
        }
        actions={
          revoked ? undefined : (
            <>
              <RoleGate allowed={canManage} reason={denied}>
                <Button
                  variant="secondary"
                  size="md"
                  onClick={(event) => {
                    opener.remember(event);
                    setExtending(true);
                  }}
                >
                  {address.status === "expired" ? "Reopen" : "Extend"}
                </Button>
              </RoleGate>
              <RoleGate allowed={canManage} reason={denied}>
                <Button
                  variant="danger"
                  size="md"
                  onClick={(event) => {
                    opener.remember(event);
                    setRevoking(true);
                  }}
                >
                  Revoke
                </Button>
              </RoleGate>
            </>
          )
        }
      />

      {forwardError ? (
        <div className="pb-4">
          <Alert tone="warn" title="Address created, forwarding not set up">
            {forwardError}
          </Alert>
        </div>
      ) : null}

      {revoked && address.revoked_at ? (
        <div className="pb-4">
          <Alert tone="warn" title="Address revoked">
            Revoked {dayLabel(new Date(address.revoked_at), zone)}. Mail to it drops and counts, and its mail already received stays until retention runs out.
          </Alert>
        </div>
      ) : null}

      <div className="flex flex-col gap-6">
        <Card className="grid gap-6 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <Usage label="Received" value={counts.received} limit={address.message_cap} limitLabel="Cap" />
          <Usage label="Today (UTC)" value={counts.received_today} limit={dailyLimit} limitLabel="Daily limit" />
          <div className="flex flex-col gap-2">
            <span className="type-label text-muted-foreground">Forwarded</span>
            <span className={cn("font-mono text-2xl font-medium tabular-nums", counts.forwarded === 0 ? "text-muted-foreground" : "text-foreground")}>
              {formatNumber(counts.forwarded)}
            </span>
            <span className="text-2xs text-muted-foreground">
              {targets.length === 0 ? "No mailboxes" : `${formatNumber(confirmed)} of ${formatNumber(targets.length)} ${targets.length === 1 ? "mailbox" : "mailboxes"} confirmed`}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <span className="type-label text-muted-foreground">
              <Term term="address_dropped">Dropped</Term>
            </span>
            <span className={cn("font-mono text-2xl font-medium tabular-nums", dropped === 0 ? "text-muted-foreground" : "text-foreground")}>
              {formatNumber(dropped)}
            </span>
            <ul className="flex flex-col gap-0.5 text-2xs text-muted-foreground">
              {dropReasons(counts).map((part) => (
                <li key={part.reason} className="flex justify-between gap-3">
                  <span>{part.reason.charAt(0).toUpperCase() + part.reason.slice(1)}</span>
                  <span className={cn("font-mono tabular-nums", part.count > 0 ? "text-foreground" : null)}>{formatNumber(part.count)}</span>
                </li>
              ))}
            </ul>
          </div>
        </Card>

        <Card className="p-5">
          <KeyValueList
            items={[
              { label: "Address id", value: address.id, copy: address.id, mono: true },
              {
                label: "Key",
                value: address.key_id ? (
                  <TextLink href={`/keys/${address.key_id}`}>{keyName ?? address.key_id}</TextLink>
                ) : (
                  <span className="text-muted-foreground">Deleted. Its mail fires no webhook.</span>
                ),
              },
              { label: address.status === "expired" ? "Expired" : "Expires", value: absoluteTime(new Date(address.expires_at), zone) },
              { label: "Created", value: <Time date={new Date(address.created_at)} /> },
            ]}
          />
        </Card>

        <section className="flex flex-col gap-3">
          <SectionHeader
            title="Forwarding"
            meta={targets.length > 0 ? `${formatNumber(targets.length)} of 5 mailboxes.` : undefined}
          />
          {targets.length === 0 ? (
            <Card className="p-5">
              <p className="type-body-sm text-muted-foreground">
                No mailboxes. Add one with <code className="break-all font-mono text-xs">POST /v1/addresses/{address.id}/forward_targets</code>. It confirms
                by a link before anything forwards.
              </p>
            </Card>
          ) : (
            <Card className="overflow-hidden p-0">
              <ul className="divide-y divide-border">
                {targets.map((target) => (
                  <ForwardTargetRow key={target.id} target={target} />
                ))}
              </ul>
            </Card>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <SectionHeader title="Received mail" meta={counts.received > 0 ? `${formatNumber(counts.received)} delivered. Kept until the domain's retention runs out.` : undefined} />
          {messages.length === 0 ? (
            <EmptyState
              icon="mail"
              title={paged ? "No older mail" : "Nothing received yet"}
              description={
                paged
                  ? "Everything older has passed the domain's retention."
                  : dropped > 0
                    ? `Mail reached it, and all of it was dropped. The counts above say why.`
                    : `Mail sent to ${address.address} shows up here.`
              }
            />
          ) : (
            <Card className="overflow-hidden p-0">
              <DataTable columns={columns} rows={messages} getRowKey={(message) => message.id ?? ""} label="Received mail" />
            </Card>
          )}
          {paged || nextCursor ? (
            <div className="flex items-center justify-between text-sm">
              {paged ? (
                <Link href={`/addresses/${address.id}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                  Newest
                </Link>
              ) : (
                <span />
              )}
              {nextCursor ? (
                <Link href={`/addresses/${address.id}?${new URLSearchParams({ cursor: nextCursor }).toString()}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                  Older
                </Link>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>

      {extending ? <ExtendDialog address={address} onClose={() => setExtending(false)} /> : null}
      <RevokeDialog address={revoking ? address : null} onClose={() => setRevoking(false)} />
    </>
  );
}
