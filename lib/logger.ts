type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;

// Request-scoped context (AsyncLocalStorage) lives in lib/api/request-context.ts, which registers
// itself here. Kept out of this file so client bundles that import the logger never pull in
// node:async_hooks.
let requestIdProvider: (() => string | undefined) | undefined;

export function setRequestIdProvider(provider: () => string | undefined): void {
  requestIdProvider = provider;
}

function emit(level: Level, scope: string, args: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  const requestId = requestIdProvider?.();
  const tag = requestId ? `${scope} ${requestId}` : scope;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} [${tag}]`;
  if (level === "error") console.error(line, ...args);
  else if (level === "warn") console.warn(line, ...args);
  else console.log(line, ...args);
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(scope: string): Logger;
}

function build(scope: string): Logger {
  return {
    debug: (...args) => emit("debug", scope, args),
    info: (...args) => emit("info", scope, args),
    warn: (...args) => emit("warn", scope, args),
    error: (...args) => emit("error", scope, args),
    child: (name) => build(`${scope}:${name}`),
  };
}

export const logger = build("app");
