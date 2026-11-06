"use client";

import { startTransition, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Modal } from "@/components/ui/modal";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { SerializedAddress } from "@/lib/addresses/serialize";
import { absoluteTime, zonedTime } from "@/lib/format/time";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { countdownLabel, expiringSoon, EXTEND_OPTIONS } from "@/lib/dashboard/views/addresses";
import { useTimeZone } from "../_ui/time-zone";
import { useAction } from "../_ui/use-action";
import { extendAddressAction, revokeAddressAction } from "./actions";

/** Re-renders every 30 seconds, so a countdown left open keeps counting. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The expiry as a countdown, exact time and zone on hover. Under an hour left reads as a warning. */
export function Countdown({ address, className }: { address: Pick<SerializedAddress, "status" | "expires_at" | "revoked_at">; className?: string }) {
  const zone = useTimeZone();
  const now = useNow();
  if (address.status === "revoked" && address.revoked_at) {
    const at = new Date(address.revoked_at);
    return (
      <time dateTime={at.toISOString()} title={zonedTime(at, zone)} className={className} suppressHydrationWarning>
        Revoked {countdownLabel(at, new Date(Math.max(now.getTime(), at.getTime())))}
      </time>
    );
  }
  const at = new Date(address.expires_at);
  const soon = expiringSoon(address, now);
  const label = at.getTime() > now.getTime() ? `Expires ${countdownLabel(at, now)}` : `Expired ${countdownLabel(at, now)}`;
  return (
    <time
      dateTime={at.toISOString()}
      title={zonedTime(at, zone)}
      className={cn(className, soon ? "font-medium text-warning" : null)}
      suppressHydrationWarning
    >
      {label}
    </time>
  );
}

/** A new expiry from now, later than the current one. */
export function ExtendDialog({ address, onClose }: { address: SerializedAddress; onClose: () => void }) {
  const zone = useTimeZone();
  const [now] = useState(() => Date.now());
  const current = new Date(address.expires_at).getTime();
  const later = (seconds: number) => now + seconds * 1000 > current;
  const [choice, setChoice] = useState(() => String(EXTEND_OPTIONS.find((option) => later(option.seconds))?.seconds ?? ""));
  const extend = useAction(extendAddressAction, (state) => {
    if (state.status === "error") toast({ title: state.message, variant: "error" });
    if (state.status === "ok") {
      toast({ title: state.message, variant: "success" });
      onClose();
    }
  });
  const expired = address.status === "expired";

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={expired ? "Reopen address" : "Extend address"}
      description={
        <>
          <span className="break-all font-mono">{address.address}</span>{" "}
          {expired ? "expired" : "expires"} {absoluteTime(new Date(address.expires_at), zone)}. Choose a new expiry, counted from now.
        </>
      }
      footer={
        <>
          <Button type="button" variant="secondary" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="extend-address" size="md" loading={extend.pending} disabled={!choice}>
            {expired ? "Reopen" : "Extend"}
          </Button>
        </>
      }
    >
      <form id="extend-address" action={extend.formAction} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={address.id} />
        <input type="hidden" name="expires_in" value={choice} />
        <RadioGroup value={choice} onValueChange={setChoice} aria-label="New expiry" className="flex flex-col gap-1">
          {EXTEND_OPTIONS.map((option) => {
            const allowed = later(option.seconds);
            return (
              <label
                key={option.seconds}
                className={[
                  "flex items-center justify-between gap-3 rounded-lg px-2 py-2 type-body-sm",
                  allowed ? "text-foreground hover:bg-muted" : "text-muted-foreground",
                ].join(" ")}
              >
                <span className="flex items-center gap-2.5">
                  <RadioGroupItem value={String(option.seconds)} disabled={!allowed} />
                  {option.label}
                </span>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {allowed ? absoluteTime(new Date(now + option.seconds * 1000), zone) : "Before its expiry"}
                </span>
              </label>
            );
          })}
        </RadioGroup>
        {expired ? <p className="type-body-sm text-foreground-soft">It counts against the organization&rsquo;s active limit again.</p> : null}
      </form>
    </Modal>
  );
}

export function RevokeDialog({ address, onClose }: { address: SerializedAddress | null; onClose: () => void }) {
  const revoke = useAction(revokeAddressAction);
  return (
    <ConfirmDialog
      open={address !== null}
      onOpenChange={(open) => !open && onClose()}
      title="Revoke this address?"
      consequence={
        address ? (
          <>
            Mail to <span className="break-all font-mono">{address.address}</span> drops from now on and forwarding stops. It can&rsquo;t be reopened or
            issued again.
          </>
        ) : null
      }
      confirmLabel="Revoke address"
      tone="destructive"
      loading={revoke.pending}
      onConfirm={() => {
        if (!address) return;
        const form = new FormData();
        form.set("id", address.id);
        startTransition(() => revoke.formAction(form));
        onClose();
      }}
    />
  );
}
