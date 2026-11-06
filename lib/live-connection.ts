export type LiveState = "connecting" | "live" | "off" | "offline";

export interface LiveSource {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close: () => void;
}

export interface LiveConnectionOptions {
  /** Opens a fresh source. Called again on every reconnect attempt. */
  createSource: () => LiveSource;
  isOnline: () => boolean;
  onState: (state: LiveState) => void;
  onMessage: (event: MessageEvent) => void;
  /** Reconnects this many times before settling on "off". */
  maxAttempts?: number;
  /** Base backoff, multiplied by the attempt number. */
  retryMs?: number;
}

export interface LiveConnection {
  start: () => void;
  stop: () => void;
  handleOffline: () => void;
  handleOnline: () => void;
}

export function createLiveConnection(options: LiveConnectionOptions): LiveConnection {
  const maxAttempts = options.maxAttempts ?? 3;
  const retryMs = options.retryMs ?? 3000;

  let attempts = 0;
  let source: LiveSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function clearRetry() {
    if (retry !== null) {
      clearTimeout(retry);
      retry = null;
    }
  }

  function closeSource() {
    source?.close();
    source = null;
  }

  function connect() {
    if (stopped) return;
    if (!options.isOnline()) {
      options.onState("offline");
      return;
    }

    source = options.createSource();

    source.onopen = () => {
      attempts = 0;
      options.onState("live");
    };

    source.onmessage = (event) => options.onMessage(event);

    // The source retries on its own forever; closing here keeps that under this budget instead.
    source.onerror = () => {
      closeSource();
      if (stopped) return;
      if (!options.isOnline()) {
        options.onState("offline");
        return;
      }
      attempts += 1;
      if (attempts >= maxAttempts) {
        options.onState("off");
        return;
      }
      options.onState("connecting");
      retry = setTimeout(connect, retryMs * attempts);
    };
  }

  function handleOffline() {
    clearRetry();
    closeSource();
    options.onState("offline");
  }

  function handleOnline() {
    attempts = 0;
    clearRetry();
    connect();
  }

  function stop() {
    stopped = true;
    clearRetry();
    closeSource();
  }

  return { start: connect, stop, handleOffline, handleOnline };
}
