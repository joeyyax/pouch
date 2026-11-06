"use client";

import { useEffect, useState } from "react";
import type { MessageStatus } from "@/lib/db/schema/messages";
import { createLiveConnection, type LiveState } from "@/lib/live-connection";

/** Reconnects a few times before giving up, matching `messages/use-live-updates.ts`. */
const MAX_ATTEMPTS = 3;
const RETRY_MS = 3000;

/** A test-mode message resolves a few seconds after `sent` (`worker/test-mode.ts`); a real
 * send can take longer. Past this, stop watching and let the "view message" link carry it. */
const WATCH_TIMEOUT_MS = 30_000;

const TERMINAL = new Set<MessageStatus>(["delivered", "bounced", "complained", "failed"]);

interface MessageUpdatePayload {
  messageId?: string;
  status?: MessageStatus;
}

/**
 * Tracks one message's status live, filtering the same per-organization SSE stream
 * `messages/use-live-updates.ts` uses for the list, down to a single message id.
 * Settles on "off" when the stream can't be reached or the wait runs long — the card then
 * falls back to whatever status it last saw, with a link to the message page.
 */
export function useMessageStatus(messageId: string, initialStatus: MessageStatus) {
  const [status, setStatus] = useState<MessageStatus>(initialStatus);
  // "connecting" even when already offline: the server can't check `navigator`, so reading it
  // here would mismatch the server-rendered value and fail hydration. The effect below corrects
  // it to "offline" immediately after mount instead.
  const [stream, setStream] = useState<LiveState>(TERMINAL.has(initialStatus) ? "off" : "connecting");

  useEffect(() => {
    if (TERMINAL.has(initialStatus)) return;

    let watchdog: ReturnType<typeof setTimeout> | null = null;

    function armWatchdog() {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        setStream("off");
        connection.stop();
      }, WATCH_TIMEOUT_MS);
    }

    const connection = createLiveConnection({
      createSource: () => new EventSource("/api/dashboard/messages"),
      isOnline: () => navigator.onLine,
      maxAttempts: MAX_ATTEMPTS,
      retryMs: RETRY_MS,
      onState: setStream,
      onMessage: (event) => {
        let payload: MessageUpdatePayload;
        try {
          payload = JSON.parse(event.data) as MessageUpdatePayload;
        } catch {
          return;
        }
        if (payload.messageId !== messageId || !payload.status) return;
        setStatus(payload.status);
        if (TERMINAL.has(payload.status)) connection.stop();
      },
    });

    // The watch timeout is about giving up on a slow provider, not on a dead network — pause it
    // on `offline` (via the wrapped handler below) so a blip doesn't cost the rest of the window.
    function handleOffline() {
      if (watchdog) clearTimeout(watchdog);
      watchdog = null;
      connection.handleOffline();
    }

    function handleOnline() {
      armWatchdog();
      connection.handleOnline();
    }

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    armWatchdog();
    connection.start();

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      if (watchdog) clearTimeout(watchdog);
      connection.stop();
    };
  }, [messageId, initialStatus]);

  return { status, stream };
}
