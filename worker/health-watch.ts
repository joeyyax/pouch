import { logger } from "@/lib/logger";
import { readiness } from "@/lib/health/readyz";
import { watchChecks, watchStore } from "@/lib/health/watch";
import { redis } from "@/lib/redis";
import { IntervalLoop } from "@/lib/worker/interval-loop";

const log = logger.child("worker:health-watch");

/** The worker check reads the heartbeat of the process running this, so it can only pass or flap with Redis. */
const UNWATCHED = new Set(["worker"]);

export interface HealthWatchLoopOptions {
  workerId?: string;
  intervalMs: number;
}

/** Runs every registered health check and pushes when one changes state. */
export class HealthWatchLoop extends IntervalLoop<number> {
  protected readonly name = "health-watch";
  protected readonly log = log;
  protected readonly intervalMs: number;
  protected readonly workerId: string | undefined;

  constructor(options: HealthWatchLoopOptions) {
    super();
    this.intervalMs = options.intervalMs;
    this.workerId = options.workerId;
  }

  protected async run(): Promise<number> {
    if (!(await this.claimPass())) return 0;
    const report = await readiness();
    const checks = Object.fromEntries(Object.entries(report.checks).filter(([name]) => !UNWATCHED.has(name)));
    return (await watchChecks(watchStore, checks)).length;
  }

  /** One replica watches per interval. */
  private async claimPass(): Promise<boolean> {
    const client = redis();
    if (!client) return true;
    try {
      const ttlMs = Math.max(1, Math.floor(this.intervalMs * 0.9));
      return (await client.set("health:watch:claim", this.workerId ?? "worker", "PX", ttlMs, "NX")) === "OK";
    } catch {
      return true;
    }
  }
}
