"use client";

import { keepValues } from "../../../_ui/keep-values";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, fieldClasses } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { SecretReveal } from "@/components/ui/secret-reveal";
import type { ReactNode } from "react";
import type { AdminKeyListItem } from "@/lib/dashboard/keys";
import { useOpenerFocus } from "@/hooks/use-opener-focus";
import { SectionHeader } from "../../../_ui/section-header";
import { Time } from "../../../_ui/time";
import { toastError, useAction } from "../../../_ui/use-action";
import { createAdminKeyAction, revokeAdminKeyAction, type CreateAdminKeyState } from "./actions";

export function ApiKeysScreen({ keys }: { keys: AdminKeyListItem[] }) {
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<AdminKeyListItem | null>(null);
  const revoke = useAction(revokeAdminKeyAction);
  const opener = useOpenerFocus();

  const active = keys.filter((key) => !key.revokedAt);
  const revoked = keys.filter((key) => Boolean(key.revokedAt));

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        title="API keys"
        description="For the admin API. They don't expire and stop working when their creator loses admin access."
        meta={active.length > 0 ? `${active.length} active` : undefined}
        actions={
          <Button size="md" onClick={() => setCreating(true)}>
            New admin key
          </Button>
        }
      />

      <Card className="overflow-hidden p-0">
        {active.length === 0 ? (
          <EmptyState
            icon="key"
            title="No admin keys"
            description="Create one to use the admin API or the MCP's admin tools."
          />
        ) : (
          <ul>
            {active.map((key) => (
              <li
                key={key.id}
                className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-border p-5 last:border-b-0"
              >
                <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-mono font-semibold text-foreground">
                    {key.name}
                    {key.refused ? <Chip tone="warn">refused</Chip> : null}
                  </p>
                  {key.refused ? (
                    <p className="type-body-sm mt-1 text-foreground-soft">
                      Its creator is no longer an admin, so every request with it is refused.
                    </p>
                  ) : null}
                  <details className="mt-1">
                    <summary className="type-body-sm cursor-pointer text-muted-foreground">Details</summary>
                    <dl className="type-body-sm mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                      <dt className="text-muted-foreground">Prefix</dt>
                      <dd className="font-mono text-foreground">{key.secretPrefix}…</dd>
                      <dt className="text-muted-foreground">Created by</dt>
                      <dd className="text-foreground">{creatorLabel(key)}</dd>
                      <dt className="text-muted-foreground">Created</dt>
                      <dd className="text-foreground"><Time date={key.createdAt} /></dd>
                    </dl>
                  </details>
                </div>
                <div className="flex w-full items-center justify-between gap-5 sm:w-auto">
                  <div className="sm:text-right">
                    <p className="type-label text-muted-foreground">Last used</p>
                    <p className="font-semibold tabular-nums text-foreground">
                      {key.lastUsedAt ? <Time date={key.lastUsedAt} /> : "Never"}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={(event) => {
                      opener.remember(event);
                      setConfirming(key);
                    }}
                  >
                    Revoke
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {revoked.length > 0 ? (
        <details className="rounded-2xl border border-border bg-card">
          <summary className="cursor-pointer px-4 py-3 type-body-sm font-semibold text-foreground">
            {revoked.length} revoked {revoked.length === 1 ? "key" : "keys"}
          </summary>
          <ul className="border-t border-border px-4 py-3">
            {revoked.map((key) => (
              <li key={key.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2">
                <span className="font-mono text-sm text-muted-foreground">{key.name}</span>
                <span className="type-body-sm text-muted-foreground">{revokedLabel(key)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {creating ? <CreateDialog onClose={() => setCreating(false)} /> : null}

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        onCloseAutoFocus={opener.restore}
        title={confirming ? `Revoke ${confirming.name}?` : ""}
        consequence="Anything using it loses admin access immediately."
        confirmLabel="Revoke"
        tone="destructive"
        loading={revoke.pending}
        onConfirm={() => {
          if (!confirming) return;
          const form = new FormData();
          form.set("id", confirming.id);
          revoke.formAction(form);
          setConfirming(null);
        }}
      />
    </section>
  );
}

function creatorLabel(key: AdminKeyListItem): string {
  if (!key.creatorName) return "A deleted account";
  return key.creatorEmail ? `${key.creatorName} (${key.creatorEmail})` : key.creatorName;
}

function revokedLabel(key: AdminKeyListItem): ReactNode {
  const why =
    key.revokedReason === "creator_demoted"
      ? ` when ${key.creatorName ?? "its creator"} stopped being an admin`
      : key.revokedReason === "creator_deleted"
        ? " when its creator's account was deleted"
        : "";
  return (
    <>
      Revoked {key.revokedAt ? <Time date={key.revokedAt} /> : null}
      {why}
    </>
  );
}

const inputClass = `${fieldClasses({ shape: "compact", size: "md" })} w-full font-mono`;

/** The form and the shown-once secret are one dialog: the secret only exists between them. */
function CreateDialog({ onClose }: { onClose: () => void }) {
  const { state, formAction, pending } = useAction<CreateAdminKeyState>(createAdminKeyAction, (next) => {
    if (next.status === "error" && !next.field) toastError(next);
  });

  if (state.status === "created") {
    return (
      <Modal
        open
        onOpenChange={(open) => !open && onClose()}
        title="Admin key created"
        description="Copy the secret now. It isn't shown again."
      >
        <SecretReveal
          value={state.secret}
          label="key"
          title={<span className="font-mono">{state.name}</span>}
          onClose={onClose}
        />
      </Modal>
    );
  }

  const error = state.status === "error" ? state : null;

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title="New admin key"
      description="It can manage every provider and organization. Name it after where it runs."
    >
      <form onSubmit={keepValues(formAction)} className="flex flex-col gap-5">
        <Field
          id="admin-key-name"
          label="Name"
          hint="Letters, digits, hyphens."
          error={error?.field === "name" ? error.message : undefined}
        >
          <input
            id="admin-key-name"
            name="name"
            required
            maxLength={64}
            autoComplete="off"
            placeholder="mcp-laptop"
            className={inputClass}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="md" loading={pending}>
            Create key
          </Button>
        </div>
      </form>
    </Modal>
  );
}
