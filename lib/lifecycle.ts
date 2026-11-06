import { logger } from "./logger";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("lifecycle");

interface Hook {
  name: string;
  fn: () => Promise<void> | void;
  drain: boolean;
  timeoutMs?: number;
}

export interface ShutdownOptions {
  /** Waits for in-flight work: runs before teardown, alongside the other drains, with the drain budget. */
  drain?: boolean;
  /** This hook's own budget. Defaults to SHUTDOWN_HOOK_TIMEOUT_MS, or the drain budget for a drain. */
  timeoutMs?: number;
}

interface State {
  hooks: Hook[];
  installed: boolean;
  /** The host owns SIGTERM and SIGINT and calls `runShutdownNow` itself. */
  deferSignals: boolean;
  /** The shutdown in progress. Every caller after the first waits on the same one. */
  shutdown: Promise<void> | null;
}

const globalForLifecycle = globalThis as unknown as { __lifecycle?: State };

const state: State =
  globalForLifecycle.__lifecycle ??
  (globalForLifecycle.__lifecycle = { hooks: [], installed: false, deferSignals: false, shutdown: null });

const HOOK_TIMEOUT_MS = Number(process.env.SHUTDOWN_HOOK_TIMEOUT_MS ?? "8000");
/** Longer than a provider call's 60s timeout. `stop_grace_period` in the compose file must cover this plus teardown. */
const DRAIN_TIMEOUT_MS = Number(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS ?? "75000");

function withTimeout(label: string, fn: () => Promise<void> | void, budget: number): Promise<void> {
  return Promise.race([
    Promise.resolve().then(fn),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        log.warn(`shutdown hook ${label} exceeded ${budget}ms`);
        resolve();
      }, budget).unref(),
    ),
  ]);
}

function runShutdown(reason: string): Promise<void> {
  state.shutdown ??= shutdown(reason);
  return state.shutdown;
}

async function shutdown(reason: string): Promise<void> {
  log.info(`shutdown begin (${reason})`);
  const run = (hook: Hook, budget: number) =>
    withTimeout(hook.name, hook.fn, budget).catch((err: unknown) =>
      log.warn(`shutdown hook ${hook.name} threw: ${safeErrorMessage(err)}`),
    );

  await Promise.all(state.hooks.filter((h) => h.drain).map((hook) => run(hook, hook.timeoutMs ?? DRAIN_TIMEOUT_MS)));
  for (const hook of state.hooks.filter((h) => !h.drain).reverse()) await run(hook, hook.timeoutMs ?? HOOK_TIMEOUT_MS);
  log.info("shutdown complete");
}

/**
 * Leaves SIGTERM and SIGINT to the host process, which calls `runShutdownNow` at its own point.
 * Call before the first `onShutdown`; `beforeExit` still runs the hooks.
 */
export function deferSignalsToHost(): void {
  state.deferSignals = true;
}

/**
 * Registers a shutdown hook, run on SIGTERM, SIGINT and beforeExit.
 * Drains run first and concurrently; the rest follow in reverse registration order, each with
 * its own timeout.
 */
export function onShutdown(name: string, fn: () => Promise<void> | void, options: ShutdownOptions = {}): void {
  const existing = state.hooks.findIndex((h) => h.name === name);
  if (existing >= 0) state.hooks.splice(existing, 1);
  state.hooks.push({ name, fn, drain: options.drain ?? false, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });

  if (!state.installed) {
    state.installed = true;
    if (!state.deferSignals) {
      process.once("SIGTERM", () => void runShutdown("SIGTERM"));
      process.once("SIGINT", () => void runShutdown("SIGINT"));
    }
    process.once("beforeExit", () => void runShutdown("beforeExit"));
  }
}

export function runShutdownNow(reason = "manual"): Promise<void> {
  return runShutdown(reason);
}

/**
 * For the Next server: next's start-server.js closes the server, waits for pending requests,
 * then calls process.exit(143). The hooks run inside that exit, after the requests finish.
 */
export function runHooksOnHostExit(): void {
  deferSignalsToHost();
  const exit = process.exit.bind(process);
  let exiting = false;
  process.exit = ((code?: number) => {
    if (exiting) return exit(code);
    exiting = true;
    void runShutdown("exit").finally(() => exit(code));
  }) as typeof process.exit;
}

/** Clears registered hooks and the shutting-down flag. Tests only. */
export function resetLifecycle(): void {
  state.hooks = [];
  state.installed = false;
  state.deferSignals = false;
  state.shutdown = null;
}
