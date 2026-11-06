"use client";

import { startTransition, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, fieldClasses } from "@/components/ui/field";
import { FieldMessage } from "@/components/ui/field-message";
import type { InProgressTestMessage } from "@/lib/dashboard/domains";
import type { MessageStatus } from "@/lib/db/schema/messages";
import { useAction } from "../_ui/use-action";
import { sendTestEmailAction } from "./actions";
import { TestEmailStatus } from "./test-email-status";
import { useCountdown } from "./use-countdown";

const inputClass = `${fieldClasses({ shape: "compact", size: "md" })} w-full font-mono`;

/** `/messages/:id` from `succeeded()`'s href — the only place the id lives in ActionState. */
function messageIdFromHref(href: string): string | null {
  return href.split("/").pop() || null;
}

interface Active {
  id: string;
  status: MessageStatus;
  to: string;
  href: string;
}

export function TestEmailCard({
  domainId,
  domainName,
  defaultTo,
  hasLayout,
  inProgressTest,
}: {
  domainId: string;
  domainName: string;
  defaultTo: string;
  hasLayout: boolean;
  inProgressTest: InProgressTestMessage | null;
}) {
  const { state, formAction, pending } = useAction(sendTestEmailAction);
  const [toValue, setToValue] = useState(defaultTo);
  const [layoutOn, setLayoutOn] = useState(hasLayout);

  // Dismissing stops watching a message client-side only — it can't cancel an accepted send.
  // Keyed by domain, one value is enough: this card only ever tracks one message at a time.
  const dismissKey = `pouch:test-email-dismissed:${domainId}`;
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reading a client-only value (localStorage) after mount, not a derived-state loop
      setDismissedId(localStorage.getItem(dismissKey));
    } catch {
      // Private mode or storage disabled — dismissal just won't survive a reload.
    }
  }, [dismissKey]);

  const cooldownMs = state.status === "error" ? state.retryAfterMs : undefined;
  const cooldownSeconds = useCountdown(cooldownMs);

  const candidate: Active | null = useMemo(() => {
    if (state.status === "ok" && state.href) {
      const id = messageIdFromHref(state.href);
      if (id) return { id, status: "queued", to: toValue, href: state.href };
    }
    if (inProgressTest) {
      return { id: inProgressTest.id, status: inProgressTest.status, to: inProgressTest.to, href: `/messages/${inProgressTest.id}` };
    }
    return null;
    // toValue intentionally excluded — the "to" recorded here is frozen at send time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, inProgressTest]);

  const active = candidate && candidate.id !== dismissedId ? candidate : null;

  function dismiss() {
    if (!active) return;
    setDismissedId(active.id);
    try {
      localStorage.setItem(dismissKey, active.id);
    } catch {
      // Nothing to persist, but the in-memory dismissal for this view still applies.
    }
  }

  function retry(local: "bounce" | "defer" | "slow") {
    const address = `${local}@${domainName}`;
    setToValue(address);
    const fd = new FormData();
    fd.set("domainId", domainId);
    fd.set("to", address);
    if (layoutOn) fd.set("layout", "on");
    startTransition(() => formAction(fd));
  }

  if (active) {
    return (
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="type-title text-base text-foreground">Send a test email</h2>
        </div>
        <TestEmailStatus
          messageId={active.id}
          initialStatus={active.status}
          toAddress={active.to}
          viewHref={active.href}
          onRetry={retry}
          onDismiss={dismiss}
          retryDisabled={pending || cooldownSeconds > 0}
          cooldownSeconds={cooldownSeconds}
          justSent={state.status === "ok" && active.href === state.href}
        />
      </Card>
    );
  }

  const error = state.status === "error" ? state : null;
  const fieldError = (name: string) => (error?.field === name ? error.message : undefined);
  const generalError = error && !error.field && !cooldownMs ? error.message : undefined;

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="type-title text-base text-foreground">Send a test email</h2>
      </div>

      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="domainId" value={domainId} />

        <Field id="test-to" label="To" error={fieldError("to")} className="flex flex-col gap-1.5">
          <input
            id="test-to"
            name="to"
            type="email"
            value={toValue}
            onChange={(event) => setToValue(event.target.value)}
            className={inputClass}
            autoComplete="off"
            spellCheck={false}
            required
          />
        </Field>

        <label className="flex items-center gap-2 type-body-sm text-foreground-soft">
          <Checkbox
            id="test-layout"
            name="layout"
            value="on"
            checked={layoutOn}
            onCheckedChange={(value) => setLayoutOn(value === true)}
            disabled={!hasLayout}
          />
          <span>
            Wrap in layout
            {!hasLayout ? <span className="text-muted-foreground"> — no layout set on this domain</span> : null}
          </span>
        </label>

        {generalError ? <FieldMessage tone="error">{generalError}</FieldMessage> : null}

        <div className="flex justify-end">
          <Button type="submit" size="md" disabled={pending || cooldownSeconds > 0}>
            {cooldownSeconds > 0 ? `Try again in ${cooldownSeconds}s` : pending ? "Sending…" : "Send test"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
