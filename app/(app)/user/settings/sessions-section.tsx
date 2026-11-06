"use client";

import { startTransition, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { SessionSummary } from "@/lib/dashboard/user-settings";
import { formatNumber } from "@/lib/format/number";
import { Time } from "../../_ui/time";
import { useOpenerFocus } from "@/hooks/use-opener-focus";
import { useAction } from "../../_ui/use-action";
import { revokeOtherSessionsAction, revokeSessionAction } from "./actions";
import { deviceLabel } from "./device-label";

/** Other sessions shown before "Show all". */
const RECENT = 4;

export function SessionsSection({ sessions }: { sessions: SessionSummary[] }) {
  const revoke = useAction(revokeSessionAction);
  const revokeOthers = useAction(revokeOtherSessionsAction);
  const [confirming, setConfirming] = useState<SessionSummary | null>(null);
  const [confirmingOthers, setConfirmingOthers] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const opener = useOpenerFocus();

  const others = sessions.filter((session) => !session.current);
  const shown = [...sessions.filter((session) => session.current), ...(expanded ? others : others.slice(0, RECENT))];
  const collapsed = !expanded && others.length > RECENT;

  return (
    <Card className="overflow-hidden p-0">
      <ul>
        {shown.map((session) => (
          <li
            key={session.id}
            className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5 last:border-b-0"
          >
            <div className="min-w-0">
              <p className="flex items-center gap-2 font-semibold text-foreground">
                {deviceLabel(session.device)}
                {session.current ? <Chip>this device</Chip> : null}
              </p>
              <p className="type-body-sm flex flex-wrap gap-x-2 text-muted-foreground">
                <span>
                  Signed in <Time date={session.createdAt} />
                </span>
                {session.ipAddress ? <span className="min-w-0 break-all font-mono text-xs leading-5">{session.ipAddress}</span> : null}
              </p>
            </div>
            {session.current ? (
              <span className="type-body-sm text-muted-foreground">Sign out from the nav to end this session.</span>
            ) : (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={(event) => {
                  opener.remember(event);
                  setConfirming(session);
                }}
              >
                Revoke
              </Button>
            )}
          </li>
        ))}
      </ul>

      {others.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3">
          {collapsed ? (
            <Button type="button" variant="ghost" className="text-sm" onClick={() => setExpanded(true)}>
              Show all {formatNumber(sessions.length)}
            </Button>
          ) : (
            <span />
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={revokeOthers.pending}
            onClick={(event) => {
              opener.remember(event);
              setConfirmingOthers(true);
            }}
          >
            Sign out all other sessions
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmingOthers}
        onOpenChange={setConfirmingOthers}
        onCloseAutoFocus={opener.restore}
        title={others.length === 1 ? "Sign out 1 other session?" : `Sign out ${formatNumber(others.length)} other sessions?`}
        consequence="Every device but this one signs out immediately."
        confirmLabel="Sign out other sessions"
        tone="destructive"
        loading={revokeOthers.pending}
        onConfirm={() => {
          startTransition(() => revokeOthers.formAction(new FormData()));
          setConfirmingOthers(false);
        }}
      />

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        onCloseAutoFocus={opener.restore}
        title={confirming ? `Revoke ${deviceLabel(confirming.device)}?` : ""}
        consequence="That device signs out immediately."
        confirmLabel="Revoke session"
        tone="destructive"
        loading={revoke.pending}
        onConfirm={() => {
          if (!confirming) return;
          const form = new FormData();
          form.set("token", confirming.token);
          revoke.formAction(form);
          setConfirming(null);
        }}
      />
    </Card>
  );
}
