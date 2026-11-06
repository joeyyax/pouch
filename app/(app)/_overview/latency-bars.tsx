import { formatDuration, LATENCY_FLOOR, spellDuration, type Latency } from "@/lib/metrics/duration";
import { Term } from "../_ui/term";

export interface LatencyStage {
  label: string;
  help: string;
  /** Finishes "50% of sends took 3 seconds or less …". */
  span: string;
  latency: Latency;
}

function took(share: number, ms: number | null, span: string): string {
  if (ms === null) return "";
  const time = ms < 1000 ? "under a second" : `${spellDuration(ms)} or less`;
  return `${share}% of sends took ${time} ${span}.`;
}

/** Two decimals, so the server's style string matches the one the browser reads back. */
const percent = (value: number) => `${Math.round(value * 100) / 100}%`;

const measurable = (latency: Latency) => latency.count > 0 && latency.p50 !== null;

/** Each bar runs p50 to p99 on one log scale, so a long tail shows as length. */
export function LatencyBars({ stages }: { stages: LatencyStage[] }) {
  const measured = stages.filter((stage) => measurable(stage.latency));

  if (measured.length === 0) {
    return <p className="type-body-sm text-muted-foreground">No sends to time yet.</p>;
  }

  const fewest = Math.min(...measured.map((stage) => stage.latency.count));

  const lows = measured.map((stage) => stage.latency.p50 ?? 0);
  const highs = measured.map((stage) => stage.latency.p99 ?? stage.latency.p50 ?? 0);
  const min = Math.log10(Math.max(Math.min(...lows) / 2, 10));
  const max = Math.log10(Math.max(...highs) * 1.25);
  const at = (ms: number) => ((Math.log10(Math.max(ms, 10)) - min) / (max - min || 1)) * 100;

  return (
    <div className="flex flex-col gap-4">
      {stages.map(({ label, help, span, latency }) => (
        <div key={label}>
          <div className="flex items-baseline justify-between gap-4">
            <span className="type-body-sm text-foreground" title={help}>
              {label}
            </span>
            {measurable(latency) ? (
              <span className="flex items-baseline gap-3 font-mono text-xs tabular-nums text-foreground">
                <span>
                  <Term definition={took(50, latency.p50, span)} className="text-muted-foreground">p50</Term>{" "}
                  {formatDuration(latency.p50)}
                </span>
                <span>
                  <Term definition={took(95, latency.p95, span)} className="text-muted-foreground">p95</Term>{" "}
                  {formatDuration(latency.p95)}
                </span>
                <span>
                  <Term definition={took(99, latency.p99, span)} className="text-muted-foreground">p99</Term>{" "}
                  {formatDuration(latency.p99)}
                </span>
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">Nothing yet</span>
            )}
          </div>
          <div className="relative mt-2 h-2 rounded-full bg-muted" aria-hidden>
            {measurable(latency) ? (
              <>
                {/* Too narrow to draw a range, so a dot centered on p50. */}
                {at(latency.p99 ?? latency.p50 ?? 0) - at(latency.p50 ?? 0) < 1.5 ? (
                  <span
                    className="absolute inset-y-0 w-2 -translate-x-1/2 rounded-full bg-muted-foreground/45"
                    style={{ left: percent(at(latency.p50 ?? 0)) }}
                  />
                ) : (
                  <span
                    className="absolute inset-y-0 rounded-full bg-muted-foreground/45"
                    style={{
                      left: percent(at(latency.p50 ?? 0)),
                      width: percent(at(latency.p99 ?? latency.p50 ?? 0) - at(latency.p50 ?? 0)),
                    }}
                  />
                )}
                {latency.p95 !== null ? (
                  <span
                    className="absolute -inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
                    style={{ left: percent(at(latency.p95)) }}
                  />
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Bars run from p50 to p99. The tick is p95.
        {fewest < LATENCY_FLOOR ? ` Only ${fewest} ${fewest === 1 ? "message" : "messages"} so far, so these will shift.` : null}
      </p>
    </div>
  );
}
