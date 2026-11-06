export function createStore<T>(initial: T, serverValue: T = initial) {
  let state = initial;
  const subscribers = new Set<() => void>();

  function get(): T {
    return state;
  }

  function getServer(): T {
    return serverValue;
  }

  function subscribe(cb: () => void): () => void {
    subscribers.add(cb);
    return () => subscribers.delete(cb);
  }

  function set(next: T | ((prev: T) => T)) {
    state = typeof next === "function" ? (next as (prev: T) => T)(state) : next;
    subscribers.forEach((cb) => cb());
  }

  return { get, getServer, subscribe, set };
}

export function createPersistedStore<T>(
  key: string,
  initial: T,
  parse?: (raw: unknown) => T | undefined,
) {
  const store = createStore<T>(initial, initial);
  let loaded = false;

  /** Idempotent — the real value only ever loads once, on first use. */
  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return;
      const parsed: unknown = JSON.parse(raw);
      const value = parse ? parse(parsed) : (parsed as T);
      if (value !== undefined) store.set(value);
    } catch {
      // corrupted value or private mode — keep initial
    }
  }

  function subscribe(cb: () => void): () => void {
    ensureLoaded();
    return store.subscribe(cb);
  }

  /** Applies `next` and persists the result, loading first if needed. */
  function commit(next: T | ((prev: T) => T)) {
    ensureLoaded();
    store.set(next);
    try {
      localStorage.setItem(key, JSON.stringify(store.get()));
    } catch {
      // private mode — the change just won't persist across reloads
    }
  }

  return {
    get: store.get,
    getServer: store.getServer,
    subscribe,
    commit,
    ensureLoaded,
  };
}
