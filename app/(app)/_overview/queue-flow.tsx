import Link from "next/link";
import type { ReactNode } from "react";
import type { QueueReading } from "@/lib/dashboard/views/metrics";
import { BACKLOG_MS } from "@/lib/metrics/conditions";
import { spellDuration } from "@/lib/metrics/duration";
import { messagesHref } from "@/lib/messages/link";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";
import { Term } from "../_ui/term";
import { formatNumber } from "@/lib/format/number";

type Tone = "quiet" | "active" | "warning";

function Stage({
  value,
  label,
  definition,
  tone,
  href,
}: {
  value: number;
  label: ReactNode;
  definition: string;
  tone: Tone;
  href?: string;
}) {
  const number = cn(
    "font-mono text-2xl font-medium leading-none tabular-nums",
    tone === "warning" ? "text-warning" : tone === "active" ? "text-foreground" : "text-muted-foreground",
  );
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col items-start rounded-xl px-2 py-3 sm:px-3",
        tone === "warning" ? "bg-warning-soft" : "bg-muted/60",
      )}
    >
      {href && value > 0 ? (
        <Link href={href} className={cn(number, "rounded-sm underline-offset-4 hover:underline", FOCUS_RING)}>
          {formatNumber(value)}
        </Link>
      ) : (
        <span className={number}>{formatNumber(value)}</span>
      )}
      <Term definition={definition} className="mt-1.5 text-left text-xs leading-snug text-muted-foreground">
        {label}
      </Term>
    </div>
  );
}

function Arrow() {
  return (
    <svg viewBox="0 0 16 16" className="size-3 self-center text-border" aria-hidden>
      <path d="M2 8h11m-4-4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const ARROW_COLUMN = "0.75rem";

const count = (value: number) => `${formatNumber(value)} ${value === 1 ? "message" : "messages"}`;
const oldest = (ms: number | null) => (ms === null ? "" : `, the oldest for ${spellDuration(ms)}`);

function explain(queue: QueueReading) {
  return {
    held:
      queue.held === 0
        ? "Nothing is held. Mail is held when its domain is paused or the organization is suspended."
        : `${count(queue.held)} held${oldest(queue.oldestHeldMs)}, because a domain is paused or the organization is suspended. They send when the hold lifts.`,
    due:
      queue.due === 0
        ? "Nothing is waiting for a worker."
        : `${count(queue.due)} ready and waiting for a worker${oldest(queue.oldestDueMs)}.`,
    sending:
      queue.inFlight === 0 ? "No worker is sending right now." : `${count(queue.inFlight)} being handed to the provider right now.`,
    silent:
      queue.silent === 0
        ? "Every send heard back within an hour."
        : `${count(queue.silent)} handed to the provider over an hour ago with no delivery, bounce or complaint back.`,
    retrying:
      queue.backingOff === 0
        ? "Nothing is waiting to retry."
        : `${count(queue.backingOff)} waiting out a backoff before the next attempt.`,
  };
}

/** Where queued mail is right now, in the order it moves. Retries loop back to due. */
export function QueueFlow({ queue }: { queue: QueueReading }) {
  const notes = explain(queue);
  const backlog = queue.oldestDueMs !== null && queue.oldestDueMs > BACKLOG_MS;
  const tone = (value: number, warn: boolean): Tone => (warn && value > 0 ? "warning" : value > 0 ? "active" : "quiet");

  return (
    <div
      className="grid items-stretch gap-x-1 sm:gap-x-1.5"
      style={{ gridTemplateColumns: `1fr ${ARROW_COLUMN} 1fr ${ARROW_COLUMN} 1fr ${ARROW_COLUMN} 1fr` }}
    >
      <Stage value={queue.held} label="Held" definition={notes.held} tone={tone(queue.held, true)} href={messagesHref({ held: true })} />
      <Arrow />
      <Stage
        value={queue.due}
        definition={notes.due}
        label={
          <>
            Due<span className="hidden sm:inline"> now</span>
          </>
        }
        tone={tone(queue.due, backlog)}
        href={messagesHref({ statuses: ["queued"] })}
      />
      <Arrow />
      <Stage value={queue.inFlight} label="Sending" definition={notes.sending} tone={tone(queue.inFlight, false)} />
      <Arrow />
      <Stage
        value={queue.silent}
        definition={notes.silent}
        label={
          <>
            No reply<span className="hidden sm:inline"> after an hour</span>
          </>
        }
        tone={tone(queue.silent, true)}
        href={messagesHref({ statuses: ["sent"], days: 1 })}
      />

      {/* The retry loop runs from the middle of Sending back to the middle of Due. */}
      <div className="relative col-start-3 col-end-6 h-10">
        <div
          aria-hidden
          className="absolute top-0 h-4 rounded-b-xl border-x-[1.5px] border-b-[1.5px] border-border"
          style={{ left: `calc((100% - ${ARROW_COLUMN}) / 4)`, right: `calc((100% - ${ARROW_COLUMN}) / 4)` }}
        >
          <svg viewBox="0 0 10 6" className="absolute -left-[5.5px] -top-1 w-2.5 text-border" aria-hidden>
            <path d="M1 5 5 1l4 4" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <p className="absolute inset-x-0 top-5 text-center text-xs text-muted-foreground">
          <span className={cn("font-mono tabular-nums", queue.backingOff > 0 ? "text-foreground" : null)}>
            {formatNumber(queue.backingOff)}
          </span>{" "}
          <Term definition={notes.retrying}>retrying later</Term>
        </p>
      </div>
    </div>
  );
}
