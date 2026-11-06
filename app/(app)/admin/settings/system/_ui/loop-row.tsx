import { StatusDot, type StatusDotTone } from "@/components/ui/status-dot";
import { formatDuration } from "@/lib/metrics/duration";
import type { JobState, LoopLivenessView } from "@/lib/system/views";
import { Time } from "../../../../_ui/time";

const STATUS_TONE: Record<JobState, StatusDotTone> = { ok: "good", stale: "issue", failing: "issue", never: "neutral" };
const STATUS_LABEL: Record<JobState, string> = { ok: "alive", stale: "silent", failing: "failing", never: "never ran" };

/** The status is its own right-hand column, so it sits in the same place whatever the name's length. */
export function LoopRow({ loop }: { loop: LoopLivenessView }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-b border-border p-5 last:border-b-0">
      <div className="min-w-0">
        <p className="font-semibold text-foreground">{loop.label}</p>
        {loop.intervalMs !== null ? (
          <p className="type-body-sm text-muted-foreground">
            {[
              `runs every ${formatDuration(loop.intervalMs)}`,
              loop.consecutiveFailures > 0 ? `${loop.consecutiveFailures} failed in a row` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col items-end gap-0.5">
        <StatusDot tone={STATUS_TONE[loop.status]}>{STATUS_LABEL[loop.status]}</StatusDot>
        {loop.lastRunAt ? <Time date={loop.lastRunAt} className="type-body-sm text-muted-foreground" /> : null}
      </div>
    </li>
  );
}
