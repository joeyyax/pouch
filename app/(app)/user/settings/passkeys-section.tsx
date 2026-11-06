"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { fieldClasses } from "@/components/ui/field";
import { authClient } from "@/lib/auth/client";
import type { PasskeySummary } from "@/lib/dashboard/user-settings";
import { settingLocation } from "@/lib/settings/registry";
import { toast } from "@/lib/toast";
import { Time } from "../../_ui/time";
import { useOpenerFocus } from "@/hooks/use-opener-focus";
import { useAction } from "../../_ui/use-action";
import { removePasskeyAction } from "./actions";

export function PasskeysSection({ passkeys, hasPassword, canAdd }: { passkeys: PasskeySummary[]; hasPassword: boolean; canAdd: boolean }) {
  const router = useRouter();
  const remove = useAction(removePasskeyAction);
  const [label, setLabel] = useState("");
  const [registering, setRegistering] = useState(false);
  const [confirming, setConfirming] = useState<PasskeySummary | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const opener = useOpenerFocus();

  const lastUnprotected = passkeys.length === 1 && !hasPassword;

  async function addPasskey() {
    setRegistering(true);
    const { error } = await authClient.passkey.addPasskey({ name: label.trim() || undefined });
    setRegistering(false);
    if (error) {
      toast({ title: error.message ?? "The passkey couldn't be added.", variant: "error" });
      return;
    }
    setLabel("");
    toast({ title: "Passkey added.", variant: "success" });
    router.refresh();
  }

  return (
    <Card className="overflow-hidden p-0">
      {canAdd ? (
        <div className="flex flex-col gap-3 border-b border-border p-5 sm:flex-row sm:items-end sm:justify-between">
          <label className="flex flex-col gap-1.5">
            <span className="type-label text-muted-foreground">Label (optional)</span>
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Work laptop"
              maxLength={100}
              className={`${fieldClasses({ shape: "compact", size: "md" })} w-full sm:w-64`}
            />
          </label>
          <Button ref={addButton} type="button" size="md" loading={registering} onClick={addPasskey} className="shrink-0">
            Add passkey
          </Button>
        </div>
      ) : (
        <p className="type-body-sm border-b border-border p-5 text-muted-foreground">
          Passkey sign-in is turned off on this install, so passkeys can&apos;t be added or used to sign in.
        </p>
      )}

      {passkeys.length === 0 ? (
        <EmptyState
          icon="key"
          title="No passkeys yet"
          description={canAdd ? "Add one to sign in without a password." : `An admin turns passkey sign-in back on in ${settingLocation("access")}.`}
        />
      ) : (
        <ul>
          {passkeys.map((passkey) => {
            const soleCredential = lastUnprotected;
            return (
              <li
                key={passkey.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="break-words font-semibold text-foreground">{passkey.label}</p>
                  <p className="type-body-sm text-muted-foreground">
                    Added <Time date={passkey.createdAt} />
                    {soleCredential ? " · Only way into this account" : ""}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={soleCredential}
                  title={soleCredential ? "Add a password or another passkey before removing this one." : undefined}
                  onClick={(event) => {
                    opener.remember(event);
                    setConfirming(passkey);
                  }}
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        onCloseAutoFocus={opener.restore}
        title={confirming ? `Remove ${confirming.label}?` : ""}
        consequence="You won't be able to sign in with this passkey again."
        confirmLabel="Remove passkey"
        tone="destructive"
        loading={remove.pending}
        onConfirm={() => {
          if (!confirming) return;
          const form = new FormData();
          form.set("id", confirming.id);
          remove.formAction(form);
          setConfirming(null);
        }}
      />
    </Card>
  );
}
