import { readHeartbeats, readJobs } from "./index";
import { checkPostgres, checkQueue, checkRedis, checkStorage, listProviderHealth } from "./checks";
import { registerHealthCheck, runHealthChecks, type HealthReport } from "./registry";
import { assetsBucket } from "@/lib/storage";
import { bodyLifecycleStatus, inboundLifecycleStatus, readBodyLifecycle, readInboundLifecycle } from "@/lib/storage/lifecycle";
import { readSetting } from "@/lib/settings/values";

/** The ceiling on every check, including the ones that read our own tables. */
export const READINESS_DEADLINE_MS = 3000;

/*
 * Postgres, Redis and R2 live (cheap, ours); the queue and worker from what the worker writes;
 * each provider from the worker's slow-interval probe or its last real send.
 */
registerHealthCheck({ name: "postgres", critical: true, run: () => checkPostgres() });
registerHealthCheck({ name: "redis", critical: true, run: () => checkRedis() });
registerHealthCheck({ name: "storage", critical: true, run: () => checkStorage() });

registerHealthCheck({
  name: "queue",
  critical: true,
  run: async () => {
    const { ok, detail } = await checkQueue();
    return { ok, detail };
  },
});

// At least one worker is the honest floor: `docker compose up --scale` decides how many, not Pouch.
registerHealthCheck({
  name: "worker",
  critical: true,
  run: async () => {
    const beats = await readHeartbeats();
    return { ok: beats.length > 0, detail: beats.length > 0 ? null : "No worker has reported in.", counts: { count: beats.length } };
  },
});

// A provider with no domains bound can't affect a send, so a dormant one can't hold the service down.
registerHealthCheck({
  name: "providers",
  critical: true,
  run: async () => {
    const inUse = (await listProviderHealth()).filter((provider) => provider.boundDomains > 0);
    const down = inUse.filter((provider) => provider.ok === false).length;
    return { ok: down === 0, detail: down === 0 ? null : "A provider in use is down.", counts: { total: inUse.length, down } };
  },
});

// A loop that missed its window or threw on its last run. Mail may still send, so it degrades the report.
registerHealthCheck({
  name: "jobs",
  critical: false,
  run: async () => {
    const jobs = await readJobs();
    const count = (state: string) => jobs.filter((job) => job.state === state).length;
    const counts = { stale: count("stale"), failing: count("failing"), never: count("never") };
    const ok = counts.stale + counts.failing + counts.never === 0;
    return { ok, detail: ok ? null : "A worker loop is stale, failing or has never run.", counts };
  },
});

// Logo upload and hosted layout images. Mail sends without it.
registerHealthCheck({
  name: "assets",
  critical: false,
  enabled: () => assetsBucket() !== null,
  run: () => checkStorage(2000, () => assetsBucket()!),
});

// The bucket's rule has to outlast the retention ceiling, or it deletes bodies whose keys still exist. Unreadable passes.
registerHealthCheck({
  name: "body-lifecycle",
  critical: false,
  run: async () => {
    const [lifecycle, ceiling] = await Promise.all([readBodyLifecycle(), readSetting("body_retention_max_days")]);
    if (bodyLifecycleStatus(lifecycle, ceiling) !== "degraded") return { ok: true, detail: null };
    return {
      ok: false,
      detail: lifecycle.state === "none" ? "No bucket rule expires bodies." : "The bucket rule expires bodies at or under the retention ceiling.",
    };
  },
});

// A bucket rule on inbound mail has to outlast its ceiling, or it deletes mail the API still lists. No rule passes.
registerHealthCheck({
  name: "inbound-lifecycle",
  critical: false,
  run: async () => {
    const [lifecycle, ceiling] = await Promise.all([readInboundLifecycle(), readSetting("inbound_retention_max_days")]);
    if (inboundLifecycleStatus(lifecycle, ceiling) !== "degraded") return { ok: true, detail: null };
    return { ok: false, detail: "The bucket rule expires inbound mail at or under the inbound retention ceiling." };
  },
});

/** Every registered check, for `/healthz?detail`. Never on the fast poll, which stays cheap. */
export function readiness(): Promise<HealthReport> {
  return runHealthChecks(READINESS_DEADLINE_MS);
}
