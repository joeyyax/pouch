"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createLiveConnection, type LiveState } from "@/lib/live-connection";

/** Reconnects a few times before giving up, so a blip doesn't cost the rest of the session. */
const MAX_ATTEMPTS = 3;
const RETRY_MS = 3000;

/** Refreshes at most this often, so a batch changing status doesn't refetch once per message. */
const COALESCE_MS = 400;

export type { LiveState };

/**
 * Watches this organization's message status changes and re-renders the screen when one lands.
 * When the stream isn't available it settles on "off": the screen keeps whatever the server
 * rendered and stops changing. Nothing blanks and nothing throws.
 *
 * "offline" is separate from "off" — see `live-connection.ts` — and resets the retry budget on
 * reconnect rather than counting the outage against it.
 */
export function useLiveUpdates({ enabled = true, minIntervalMs = 0 }: { enabled?: boolean; minIntervalMs?: number } = {}): LiveState {
  const router = useRouter();
  // Always "connecting" on the first render: the server has no `navigator` to check against, so
  // reading it here would render one thing on the server and another on the client and fail
  // hydration. The effect below settles it to "offline" immediately after mount if it applies.
  const [state, setState] = useState<LiveState>("connecting");
  const refresh = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRefresh = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const connection = createLiveConnection({
      createSource: () => new EventSource("/api/dashboard/messages"),
      isOnline: () => navigator.onLine,
      maxAttempts: MAX_ATTEMPTS,
      retryMs: RETRY_MS,
      onState: setState,
      onMessage: () => {
        // With a minimum interval, a refresh already scheduled covers this event too.
        if (minIntervalMs > 0 && refresh.current) return;
        if (refresh.current) clearTimeout(refresh.current);
        const wait = Math.max(COALESCE_MS, lastRefresh.current + minIntervalMs - Date.now());
        refresh.current = setTimeout(() => {
          refresh.current = null;
          lastRefresh.current = Date.now();
          router.refresh();
        }, wait);
      },
    });

    window.addEventListener("offline", connection.handleOffline);
    window.addEventListener("online", connection.handleOnline);
    connection.start();

    return () => {
      window.removeEventListener("offline", connection.handleOffline);
      window.removeEventListener("online", connection.handleOnline);
      if (refresh.current) clearTimeout(refresh.current);
      refresh.current = null;
      connection.stop();
    };
  }, [router, enabled, minIntervalMs]);

  return state;
}
