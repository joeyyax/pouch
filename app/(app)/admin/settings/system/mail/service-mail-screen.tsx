"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { useOpenerFocus } from "@/hooks/use-opener-focus";
import type { ServiceMailRow, ServiceSuppressionRow } from "@/lib/system/service-mail";
import { SectionHeader } from "../../../../_ui/section-header";
import { StatusChip } from "../../../../_ui/status";
import { Time } from "../../../../_ui/time";
import { useAction } from "../../../../_ui/use-action";
import { removeServiceSuppressionAction } from "./actions";

const PATH = "/admin/settings/system/mail";

export function ServiceMailScreen({
  rows,
  nextCursor,
  paged,
  suppressed,
}: {
  rows: ServiceMailRow[];
  nextCursor: string | null;
  /** Whether this page is reached by paging back from a newer one. */
  paged: boolean;
  suppressed: ServiceSuppressionRow[];
}) {
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <SectionHeader
          title="System mail"
          description="Password resets, sign-in links, invitations, owner notifications, alerts and digests. They send through the system from address, and no organization's log holds them."
        />

        <Card className="overflow-hidden p-0">
          {rows.length === 0 ? (
            <EmptyState
              icon="mail"
              title={paged ? "Nothing older" : "No system mail yet"}
              description={paged ? "This is the end of the log." : "Mail the service sends about itself lands here as it's sent."}
            />
          ) : (
            <ul>
              {rows.map((row) => (
                <ServiceMailItem key={row.id} row={row} />
              ))}
            </ul>
          )}
        </Card>

        {paged || nextCursor ? (
          <div className="flex items-center justify-between text-sm">
            {paged ? (
              <Link href={PATH} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Newest
              </Link>
            ) : (
              <span />
            )}
            {nextCursor ? (
              <Link href={`${PATH}?before=${encodeURIComponent(nextCursor)}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Older
              </Link>
            ) : null}
          </div>
        ) : null}
      </section>

      <ServiceSuppressions rows={suppressed} />
    </div>
  );
}

function ServiceMailItem({ row }: { row: ServiceMailRow }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-5 last:border-b-0">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="truncate font-semibold text-foreground">{row.subject}</p>
        <p className="type-body-sm truncate text-muted-foreground">
          To {row.to.join(", ")} · from {row.fromAddress}
        </p>
        {row.failureReason ? <p className="type-body-sm text-foreground-soft">{row.failureReason}</p> : null}
        <div className="flex flex-wrap gap-1.5">
          {row.tags.map((tag) => (
            <Chip key={tag}>{tag}</Chip>
          ))}
          {row.withheld ? <Chip>Body withheld</Chip> : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <StatusChip status={row.status} />
        <Time date={row.createdAt} className="type-body-sm text-muted-foreground" />
      </div>
    </li>
  );
}

function ServiceSuppressions({ rows }: { rows: ServiceSuppressionRow[] }) {
  const [confirming, setConfirming] = useState<ServiceSuppressionRow | null>(null);
  const remove = useAction(removeServiceSuppressionAction);
  const opener = useOpenerFocus();

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        title="Suppressed for system mail"
        description="A bounce or complaint on system mail stops it reaching that address. Organizations' own lists are separate."
      />
      <Card className="overflow-hidden p-0">
        {rows.length === 0 ? (
          <p className="type-body-sm p-5 text-muted-foreground">No address is suppressed.</p>
        ) : (
          <ul>
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5 last:border-b-0">
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm text-foreground">{row.address}</p>
                  <p className="type-body-sm text-muted-foreground">
                    {row.reason.replace("_", " ")}
                    {row.detail ? ` · ${row.detail}` : null} · <Time date={row.createdAt} />
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(event) => {
                    opener.remember(event);
                    setConfirming(row);
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        onCloseAutoFocus={opener.restore}
        title={confirming ? `Remove ${confirming.address}?` : ""}
        consequence="System mail sends to this address again."
        confirmLabel="Remove"
        tone="destructive"
        loading={remove.pending}
        onConfirm={() => {
          if (!confirming) return;
          const form = new FormData();
          form.set("address", confirming.address);
          remove.formAction(form);
          setConfirming(null);
        }}
      />
    </section>
  );
}
