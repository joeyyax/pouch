import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveConnection, type LiveSource, type LiveState } from "@/lib/live-connection";
import { at } from "../at";

/** A fake EventSource whose failure the test drives by hand. */
function fakeSource(): LiveSource & { fail: () => void; open: () => void } {
  const source: LiveSource & { fail: () => void; open: () => void } = {
    onopen: null,
    onmessage: null,
    onerror: null,
    close: vi.fn(),
    fail: () => source.onerror?.(new Event("error")),
    open: () => source.onopen?.(new Event("open")),
  };
  return source;
}

describe("createLiveConnection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles on off after burning the retry budget", () => {
    const states: LiveState[] = [];
    const online = true;
    const sources: ReturnType<typeof fakeSource>[] = [];

    const connection = createLiveConnection({
      createSource: () => {
        const source = fakeSource();
        sources.push(source);
        return source;
      },
      isOnline: () => online,
      onState: (state) => states.push(state),
      onMessage: () => {},
      maxAttempts: 3,
      retryMs: 1000,
    });

    connection.start();
    at(sources, 0).fail();
    vi.advanceTimersByTime(1000);
    at(sources, 1).fail();
    vi.advanceTimersByTime(2000);
    at(sources, 2).fail();

    expect(states.at(-1)).toBe("off");
    expect(sources).toHaveLength(3);
  });

  it("does not spend a retry attempt while offline, and stays offline rather than off", () => {
    const states: LiveState[] = [];
    const online = false;

    const connection = createLiveConnection({
      createSource: () => fakeSource(),
      isOnline: () => online,
      onState: (state) => states.push(state),
      onMessage: () => {},
      maxAttempts: 3,
      retryMs: 1000,
    });

    connection.start();
    // Advancing well past what three retries would take: no reconnect happens while offline.
    vi.advanceTimersByTime(10_000);

    expect(states).toEqual(["offline"]);
  });

  it("resets the retry budget when the network comes back", () => {
    const states: LiveState[] = [];
    let online = true;
    const sources: ReturnType<typeof fakeSource>[] = [];

    const connection = createLiveConnection({
      createSource: () => {
        const source = fakeSource();
        sources.push(source);
        return source;
      },
      isOnline: () => online,
      onState: (state) => states.push(state),
      onMessage: () => {},
      maxAttempts: 3,
      retryMs: 1000,
    });

    connection.start();
    at(sources, 0).fail();
    vi.advanceTimersByTime(1000);
    at(sources, 1).fail();

    // Goes offline mid-backoff: the pending retry is dropped, not spent.
    online = false;
    connection.handleOffline();
    expect(states.at(-1)).toBe("offline");

    // Network returns: a fresh connection attempt, not attempt 3 of the old budget.
    online = true;
    connection.handleOnline();
    expect(sources).toHaveLength(3);
    at(sources, 2).open();
    expect(states.at(-1)).toBe("live");

    // Proving the budget reset: two more failures here should not reach "off" on their own.
    at(sources, 2).fail();
    vi.advanceTimersByTime(1000);
    at(sources, 3).fail();
    expect(states.at(-1)).toBe("connecting");
  });

  it("reports live on open and stops reconnecting once stopped", () => {
    const states: LiveState[] = [];
    const sources: ReturnType<typeof fakeSource>[] = [];

    const connection = createLiveConnection({
      createSource: () => {
        const source = fakeSource();
        sources.push(source);
        return source;
      },
      isOnline: () => true,
      onState: (state) => states.push(state),
      onMessage: () => {},
    });

    connection.start();
    at(sources, 0).open();
    expect(states).toEqual(["live"]);

    connection.stop();
    at(sources, 0).fail();
    vi.advanceTimersByTime(10_000);
    // No further attempts and no further state after stop().
    expect(sources).toHaveLength(1);
    expect(states).toEqual(["live"]);
  });
});
