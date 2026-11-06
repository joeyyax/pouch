"use client";

import { useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, fieldClasses } from "@/components/ui/field";
import { SecretReveal } from "@/components/ui/secret-reveal";
import { KEY_TREND_DAYS } from "@/lib/dashboard/views/keys";
import type { KeyDomainOption, KeyListItem } from "@/lib/dashboard/views/keys";
import { useFocusOnMount } from "@/hooks/use-opener-focus";
import { toastError, useAction } from "../_ui/use-action";
import { PageHeader } from "../_ui/page-header";
import { KeyChip } from "../_ui/status";
import { Term } from "../_ui/term";
import { CopyOnHover } from "../_ui/copy-on-hover";
import { Snippet } from "../_ui/snippet";
import { Sparkline } from "../_ui/sparkline";
import { Time } from "../_ui/time";
import { RoleGate } from "../_ui/role-gate";
import { createKeyAction, type CreatedKey, type CreateKeyState } from "./actions";
import { DomainScopeField } from "./domain-scope-field";
import { SmtpDetails } from "./smtp-details";
import { keepValues } from "../_ui/keep-values";
import { INACTIVE_ROW, settled } from "../_ui/inactive";
import { formatNumber } from "@/lib/format/number";

const columns: DataTableColumn<KeyListItem>[] = [
  {
    key: "name",
    header: "Name",
    priority: "primary",
    cell: (row) => (
      <CopyOnHover value={row.name} label="key name" className="whitespace-nowrap font-mono" hideOnTouch>
        <Link href={`/keys/${row.id}`} className="underline underline-offset-4">
          {row.name}
        </Link>
      </CopyOnHover>
    ),
  },
  {
    key: "domains",
    header: "Domains",
    priority: "primary",
    cell: (row) => (
      <span className="flex flex-wrap gap-1">
        {row.domainNames.length === 0 ? (
          <Term term="every_domain" className="text-muted-foreground">
            all
          </Term>
        ) : (
          row.domainNames.map((name) => (
            <Chip key={name} tone="value">
              {name}
            </Chip>
          ))
        )}
      </span>
    ),
  },
  {
    key: "mode",
    header: "Mode",
    cell: (row) => <KeyChip shape="dot" mode={row.mode} revoked={Boolean(row.revokedAt)} explain={row.mode === "test" || undefined} />,
  },
  {
    key: "rate",
    header: <Term term="rate_limit">Rate</Term>,
    numeric: true,
    cell: (row) => <span className="tabular-nums">{row.rateLimit}/min</span>,
  },
  {
    key: "sends",
    header: <Term definition={`Messages sent with this key in the last ${KEY_TREND_DAYS} days.`}>Sends, {KEY_TREND_DAYS}d</Term>,
    numeric: true,
    cell: (row) => {
      const total = sum(row.daily);
      if (total === 0) return <span className="tabular-nums text-muted-foreground">0</span>;
      return (
        <span className="flex items-center justify-end gap-3">
          <Sparkline
            values={row.daily}
            label={`${row.name} sends per day`}
            interactive={false}
            className="hidden h-6 w-20 sm:block"
          />
          <span className="tabular-nums">{formatNumber(total)}</span>
        </span>
      );
    },
  },
  {
    key: "lastUsed",
    header: "Last used",
    numeric: true,
    cell: (row) =>
      row.lastUsedAt ? <Time date={row.lastUsedAt} /> : <span className="text-muted-foreground">never</span>,
  },
  {
    key: "created",
    header: "Created",
    numeric: true,
    cell: (row) => <Time date={row.createdAt} className="text-muted-foreground" />,
  },
];

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** No sends in the trend window, and old enough that it isn't still being wired in. */
function inactive(key: KeyListItem): boolean {
  return sum(key.daily) === 0 && settled(key.createdAt);
}

export function KeysScreen({
  keys,
  domainOptions,
  defaultRateLimit,
  creating,
  canManage,
}: {
  keys: KeyListItem[];
  domainOptions: KeyDomainOption[];
  /** The install's rate limit for new keys. */
  defaultRateLimit: number;
  creating: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const createButton = useRef<HTMLButtonElement>(null);
  const wasCreating = useRef(creating);
  const heading = useRef<HTMLHeadingElement>(null);

  // The create flow replaces this screen, so the button that opened it is gone by the time it
  // closes and focus would land on <body>. The new button gets it instead.
  useEffect(() => {
    if (wasCreating.current && !creating) createButton.current?.focus();
    wasCreating.current = creating;
  }, [creating]);

  const live = keys.filter((key) => !key.revokedAt);
  const revoked = keys.filter((key) => Boolean(key.revokedAt));
  const sending = live.filter((key) => sum(key.daily) > 0).length;

  function setCreating(next: boolean) {
    const query = new URLSearchParams(params);
    if (next) query.set("state", "create");
    else query.delete("state");
    const suffix = query.toString();
    router.push(suffix ? `/keys?${suffix}` : "/keys", { scroll: false });
  }

  if (creating && canManage) return <CreateFlow domainOptions={domainOptions} defaultRateLimit={defaultRateLimit} onDone={() => setCreating(false)} />;

  return (
    <>
      <PageHeader
        titleRef={heading}
        title="Keys"
        description="Each key sends from its own domains at its own rate limit."
        meta={
          live.length > 0
            ? `${sending} of ${live.length} ${live.length === 1 ? "key" : "keys"} sent in the last ${KEY_TREND_DAYS} days.`
            : undefined
        }
        actions={
          <RoleGate allowed={canManage} reason="Your role doesn't let you create an API key.">
            <Button ref={createButton} size="md" onClick={() => setCreating(true)}>
              Create key
            </Button>
          </RoleGate>
        }
      />

      <Card className="overflow-hidden p-0">
        <DataTable
          label="Keys"
          columns={columns}
          rows={live}
          getRowKey={(row) => row.id}
          onRowClick={(row) => router.push(`/keys/${row.id}`, { scroll: false })}
          rowClassName={(row) => (inactive(row) ? INACTIVE_ROW : undefined)}
          empty={
            <EmptyState
              icon="key"
              title="No keys yet"
              description="Create one and scope it to a domain."
              action={
                <RoleGate allowed={canManage} reason="Your role doesn't let you create an API key.">
                  <Button size="md" onClick={() => setCreating(true)}>
                    Create key
                  </Button>
                </RoleGate>
              }
            />
          }
        />
      </Card>

      {revoked.length > 0 ? (
        <details className="mt-6 rounded-2xl border border-border bg-card">
          <summary className="cursor-pointer px-4 py-3 type-body-sm font-semibold text-foreground">
            {revoked.length} revoked {revoked.length === 1 ? "key" : "keys"}
          </summary>
          <ul className="border-t border-border px-4 py-3">
            {revoked.map((key) => (
              <li key={key.id} className="flex items-center justify-between gap-3 py-2">
                <Link
                  href={`/keys/${key.id}`}
                  className="font-mono text-sm text-muted-foreground underline underline-offset-4"
                >
                  {key.name}
                </Link>
                <KeyChip shape="dot" mode={key.mode} revoked />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

/** Fields the create form shows an error under. Any other error is toasted. */
const INLINE_FIELDS = new Set(["name", "domainIds", "rateLimit"]);

const inputClass = `${fieldClasses({ shape: "compact", size: "md" })} w-full font-mono`;

/** The form and the shown-once panel are one flow: the secret only exists between them. */
function CreateFlow({
  domainOptions,
  defaultRateLimit,
  onDone,
}: {
  domainOptions: KeyDomainOption[];
  defaultRateLimit: number;
  onDone: () => void;
}) {
  const { state, formAction, pending } = useAction<CreateKeyState>(createKeyAction, (next) => {
    if (next.status === "error" && !("field" in next && next.field && INLINE_FIELDS.has(next.field))) toastError(next);
  });
  const heading = useFocusOnMount<HTMLHeadingElement>();

  if (state.status === "created") return <CreatedPanel created={state.key} onClose={onDone} />;

  const error = state.status === "error" ? state : null;

  return (
    <form onSubmit={keepValues(formAction)}>
      <PageHeader
        titleRef={heading}
        eyebrow="Keys"
        title="Create key"
        description="Name it after the project and environment. The secret shows once, right after you create it."
      />

      <Card className="flex flex-col gap-5 p-6">
        <Field
          id="key-name"
          label="Name"
          hint="Letters, digits, hyphens."
          error={error?.field === "name" ? error.message : undefined}
        >
          <input
            id="key-name"
            name="name"
            type="text"
            placeholder="scope-production"
            className={inputClass}
            autoComplete="off"
            required
          />
        </Field>

        <DomainScopeField
          id="key-domains"
          domainOptions={domainOptions}
          error={error?.field === "domainIds" ? error.message : undefined}
        />

        <Field id="key-mode" label="Mode" hint="Test keys route every send to the mock provider.">
          <select id="key-mode" name="mode" defaultValue="live" className={inputClass}>
            <option value="live">Live</option>
            <option value="test">Test</option>
          </select>
        </Field>

        <Field
          id="key-rate"
          label="Rate limit"
          hint={`Requests per minute. Default is ${defaultRateLimit}.`}
          error={error?.field === "rateLimit" ? error.message : undefined}
        >
          <input
            id="key-rate"
            name="rateLimit"
            type="number"
            min={1}
            defaultValue={defaultRateLimit}
            className={inputClass}
          />
        </Field>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="secondary" size="md" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" size="md" disabled={pending}>
            {pending ? "Creating…" : "Create key"}
          </Button>
        </div>
      </Card>
    </form>
  );
}

function CreatedPanel({ created, onClose }: { created: CreatedKey; onClose: () => void }) {
  const scope = created.domainNames.length > 0 ? created.domainNames.join(", ") : "every domain";
  const heading = useFocusOnMount<HTMLHeadingElement>();

  return (
    <>
      <PageHeader
        titleRef={heading}
        eyebrow="Keys"
        title="Key created"
        description="Copy the secret and wire it into your app."
      />

      <SecretReveal
        value={created.secret}
        label="key"
        title={created.name}
        description={`${created.mode === "live" ? "Live" : "Test"} · ${scope} · ${created.rateLimit}/min`}
        onClose={onClose}
      >
        <FirstSend created={created} />
        <div className="flex flex-col gap-2">
          <p className="type-label text-muted-foreground">Over SMTP</p>
          <SmtpDetails smtp={created.smtp} keyId={created.id} secret={created.secret} newTab />
        </div>
      </SecretReveal>
    </>
  );
}

const linkClass = "underline underline-offset-4 hover:no-underline";

/** A new tab, so following it doesn't take the unsaved secret with it. */
const nextTab = { target: "_blank", rel: "noopener", className: linkClass } as const;

/** The next step once the secret is out: a send that works, or what stands in its way. */
function FirstSend({ created }: { created: CreatedKey }) {
  const from = created.sendFrom;

  if (!from) {
    return (
      <p className="type-body-sm text-foreground-soft">
        Next, add a domain and verify it. This key can’t send until one is.{" "}
        <Link href="/domains?state=add" {...nextTab}>
          Add a domain
        </Link>
      </p>
    );
  }

  if (!created.send) {
    return (
      <p className="type-body-sm text-foreground-soft">
        Next, verify <span className="font-mono">{from.name}</span>. Sends from it fail until its DNS records resolve.{" "}
        <Link href={`/domains/${from.id}/setup`} {...nextTab}>
          Open setup
        </Link>
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="type-label text-muted-foreground">First send</p>
      <Snippet languages={created.send} newTab />
      <p className="type-body-sm text-foreground-soft">
        Swap in your own address and run it, or send a test from{" "}
        <Link href={`/domains/${from.id}/sending`} {...nextTab}>
          <span className="font-mono">{from.name}</span>’s Sending page
        </Link>
        .
      </p>
    </div>
  );
}
