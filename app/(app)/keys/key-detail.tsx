"use client";

import { startTransition, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Field, fieldClasses } from "@/components/ui/field";
import { KeyValueList } from "@/components/ui/key-value-list";
import { TextLink } from "@/components/ui/text-link";
import { Modal } from "@/components/ui/modal";
import { KEY_TREND_DAYS, type KeyDetailData, type KeyDomainOption, type KeyUsage } from "@/lib/dashboard/views/keys";
import type { WebhookDeliveryView, WebhookEndpointView } from "@/lib/dashboard/views/webhooks";
import { idle, type ActionState } from "@/lib/dashboard/action-state";
import { dayLabel } from "@/lib/format/time";
import { dayKey } from "@/lib/dashboard/views/days";
import { addDays } from "@/lib/time-zone";
import { messagesHref } from "@/lib/messages/link";
import { toast } from "@/lib/toast";
import { useOpenerFocus } from "@/hooks/use-opener-focus";
import { PageHeader } from "../_ui/page-header";
import { SectionHeader } from "../_ui/section-header";
import { Sparkline } from "../_ui/sparkline";
import { KeyChip, StatusChip } from "../_ui/status";
import { Term } from "../_ui/term";
import { CopyOnHover } from "../_ui/copy-on-hover";
import { Time } from "../_ui/time";
import { useTimeZone } from "../_ui/time-zone";
import { useAction } from "../_ui/use-action";
import { RoleGate } from "../_ui/role-gate";
import { revokeKeyAction, updateKeyAction } from "./actions";
import type { KeySmtp } from "@/lib/dashboard/views/smtp";
import { WebhookEndpoints } from "./webhook-endpoints";
import { SmtpDetails } from "./smtp-details";
import { DomainScopeField } from "./domain-scope-field";
import { keepValues } from "../_ui/keep-values";
import { formatNumber } from "@/lib/format/number";

const inputClass = `${fieldClasses({ shape: "compact", size: "md" })} w-full font-mono`;

export function KeyDetail({
  apiKey,
  endpoints,
  deliveriesByEndpoint,
  domainOptions,
  smtp,
  canManage,
}: {
  apiKey: KeyDetailData;
  endpoints: WebhookEndpointView[];
  deliveriesByEndpoint: Record<string, WebhookDeliveryView[]>;
  domainOptions: KeyDomainOption[];
  smtp: KeySmtp;
  canManage: boolean;
}) {
  const zone = useTimeZone();
  const router = useRouter();
  const params = useSearchParams();
  const revoke = useAction(revokeKeyAction);
  const [editing, setEditing] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useOpenerFocus(heading);

  const confirming = params.get("state") === "revoke";
  const recent = apiKey.daily.reduce((total, value) => total + value, 0);

  function setConfirming(next: boolean) {
    const query = new URLSearchParams(params);
    if (next) query.set("state", "revoke");
    else query.delete("state");
    const suffix = query.toString();
    router.push(suffix ? `/keys/${apiKey.id}?${suffix}` : `/keys/${apiKey.id}`, { scroll: false });
  }

  const usageColumns: DataTableColumn<KeyUsage>[] = [
    {
      key: "subject",
      header: "Subject",
      priority: "primary",
      cellClassName: "w-full max-w-0",
      cell: (row) => <span className="block truncate">{row.subject}</span>,
    },
    {
      key: "to",
      header: "To",
      priority: "primary",
      cellClassName: "max-w-[18ch] sm:max-w-[28ch]",
      cell: (row) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <CopyOnHover value={row.to} label="address" className="font-mono" hideOnTouch>
            {row.to}
          </CopyOnHover>
          {row.recipientCount > 1 ? (
            <span className="shrink-0 text-2xs text-muted-foreground">+{row.recipientCount - 1} more</span>
          ) : null}
        </span>
      ),
    },
    { key: "status", header: "Status", cell: (row) => <StatusChip shape="dot" status={row.status} explain={row.status === "delivered" ? undefined : true} /> },
    { key: "time", header: "When", numeric: true, cellClassName: "whitespace-nowrap", cell: (row) => <Time date={row.createdAt} /> },
  ];

  return (
    <>
      <PageHeader
        titleRef={heading}
        eyebrow="Keys"
        title={<span className="font-mono">{apiKey.name}</span>}
        copy={{ value: apiKey.name, label: "key name" }}
        status={<KeyChip mode={apiKey.mode} revoked={Boolean(apiKey.revokedAt)} explain />}
        meta={
          apiKey.lastUsedAt ? (
            <>
              Last used <Time date={apiKey.lastUsedAt} />.
            </>
          ) : (
            "Never used."
          )
        }
        actions={
          apiKey.revokedAt ? undefined : (
            <>
              <RoleGate allowed={canManage} reason="Your role doesn't let you edit this key.">
                <Button variant="secondary" size="md" onClick={() => setEditing(true)}>
                  Edit key
                </Button>
              </RoleGate>
              <RoleGate allowed={canManage} reason="Your role doesn't let you revoke this key.">
                <Button
                  variant="danger"
                  size="md"
                  onClick={(event) => {
                    opener.remember(event);
                    setConfirming(true);
                  }}
                >
                  Revoke key
                </Button>
              </RoleGate>
            </>
          )
        }
      />

      {apiKey.revokedAt ? (
        <div className="pb-4">
          <Alert tone="warn" title="Key revoked">
            Revoked {dayLabel(apiKey.revokedAt, zone)}. Sends with it fail at the API.
          </Alert>
        </div>
      ) : null}

      <div className="flex flex-col gap-6">
        <Card className="p-5">
          <KeyValueList
            mono
            items={[
              { label: "Key id", value: apiKey.id, copy: apiKey.id },
              { label: "Secret prefix", value: `${apiKey.secretPrefix}${"•".repeat(12)}` },
              {
                label: "Domains",
                value:
                  apiKey.domainNames.length === 0 ? (
                    <Term term="every_domain" className="text-muted-foreground">
                      all
                    </Term>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {apiKey.domainNames.map((name) => (
                        <Chip key={name} tone="value">
                          {name}
                        </Chip>
                      ))}
                    </span>
                  ),
                mono: false,
              },
              {
                label: "Rate limit",
                value: (
                  <Term
                    definition={`Up to ${formatNumber(apiKey.rateLimit)} requests a minute. Past that, the API answers 429 with how long to wait.`}
                  >
                    {apiKey.rateLimit}/min
                  </Term>
                ),
              },
              { label: "Created", value: <Time date={apiKey.createdAt} />, mono: false },
            ]}
          />
        </Card>

        <Card className="p-5">
          <SectionHeader
            title="Recent sends"
            meta={
              apiKey.usageTotal > 0 ? (
                <>
                  <TextLink href={messagesHref({ key: apiKey.id, days: KEY_TREND_DAYS })}>
                    {`${formatNumber(recent)} in the last ${KEY_TREND_DAYS} days`}
                  </TextLink>
                  {`, ${formatNumber(apiKey.usageTotal)} in all.`}
                </>
              ) : undefined
            }
          />
          {recent > 0 ? (
            <Sparkline className="mt-4 h-10" values={apiKey.daily} labels={trendLabels(apiKey.daily.length, zone)} label="Sends per day" />
          ) : null}
          {apiKey.usage.length > 0 ? (
            <div className="mt-3 overflow-hidden rounded-xl border border-border">
              <DataTable
                label={`Recent sends with ${apiKey.name}`}
                columns={usageColumns}
                rows={apiKey.usage}
                getRowKey={(row) => row.id}
                onRowClick={(row) => router.push(`/messages/${row.id}`, { scroll: false })}
              />
            </div>
          ) : (
            <p className="type-body-sm mt-3 text-muted-foreground">
              {apiKey.revokedAt ? "Nothing was sent with this key." : "No sends yet. Sends with this key show up here."}
            </p>
          )}
        </Card>

        {!apiKey.revokedAt ? (
          <>
            <Card className="p-5">
              <SectionHeader title="SMTP" description="For software that only speaks SMTP." />
              <div className="mt-4">
                <SmtpDetails smtp={smtp} keyId={apiKey.id} secret={null} />
              </div>
            </Card>
            <WebhookEndpoints apiKeyId={apiKey.id} endpoints={endpoints} deliveriesByEndpoint={deliveriesByEndpoint} canManage={canManage} />
          </>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirming && !apiKey.revokedAt}
        onOpenChange={(open) => !open && setConfirming(false)}
        onCloseAutoFocus={opener.restore}
        title={`Revoke ${apiKey.name}?`}
        consequence="Anything using it stops sending immediately."
        confirmLabel="Revoke key"
        tone="destructive"
        loading={revoke.pending}
        onConfirm={() => {
          const form = new FormData();
          form.set("id", apiKey.id);
          startTransition(() => revoke.formAction(form));
          setConfirming(false);
        }}
        cancelLabel="Cancel"
      />

      {/* Keyed by domain scope: the dialog never unmounts on its own, so a save that widens or
          narrows the scope needs a fresh mount to pick a starting domain choice from the key
          as it now stands, rather than the choice in effect when the dialog first opened. */}
      <EditKeyDialog
        key={apiKey.domainIds.join(",")}
        apiKey={apiKey}
        domainOptions={domainOptions}
        open={editing}
        onOpenChange={setEditing}
      />
    </>
  );
}

/** `MM-DD` for each of the last `count` days in `zone`, oldest first. */
function trendLabels(count: number, zone: string): string[] {
  const today = dayKey(new Date(), zone);
  return Array.from({ length: count }, (_, index) => addDays(today, index - (count - 1)).slice(5));
}

function EditKeyDialog({
  apiKey,
  domainOptions,
  open,
  onOpenChange,
}: {
  apiKey: KeyDetailData;
  domainOptions: KeyDomainOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Field errors render under their field; a toast would say it twice.
  const { state, formAction, pending } = useAction(updateKeyAction, (next) => {
    if (next.status === "ok") toast({ title: next.message, variant: "success" });
    if (next.status === "error" && !(next.field && ["name", "domainIds", "rateLimit"].includes(next.field))) {
      toast({ title: next.message, variant: "error" });
    }
  });
  const closed = useRef<ActionState>(idle);

  useEffect(() => {
    if (closed.current === state) return;
    closed.current = state;
    if (state.status === "ok") onOpenChange(false);
  }, [state, onOpenChange]);

  const error = state.status === "error" ? state : null;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Edit key"
      description="The secret stays the same. If it leaked, revoke this key and create a new one."
      footer={
        <>
          <Button type="button" variant="secondary" size="md" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="edit-key" size="md" disabled={pending}>
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </>
      }
    >
      <form
        id="edit-key"
        onSubmit={keepValues(formAction, { id: apiKey.id })}
        className="flex flex-col gap-4"
      >
        <Field id="edit-key-name" label="Name" hint="Letters, digits, hyphens." error={error?.field === "name" ? error.message : undefined}>
          <input
            id="edit-key-name"
            name="name"
            type="text"
            defaultValue={apiKey.name}
            className={inputClass}
            autoComplete="off"
            required
          />
        </Field>

        <DomainScopeField
          id="edit-key-domains"
          domainOptions={domainOptions}
          initialIds={apiKey.domainIds}
          error={error?.field === "domainIds" ? error.message : undefined}
        />

        <Field
          id="edit-key-rate"
          label="Rate limit"
          hint="Requests per minute."
          error={error?.field === "rateLimit" ? error.message : undefined}
        >
          <input id="edit-key-rate" name="rateLimit" type="number" min={1} defaultValue={apiKey.rateLimit} className={inputClass} />
        </Field>
      </form>
    </Modal>
  );
}
