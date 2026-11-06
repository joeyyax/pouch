"use client";

import { useEffect, useState } from "react";

/**
 * Seconds remaining until a rate-limit cooldown clears. `retryAfterMs` is a snapshot from the
 * moment the action returned it; this hook turns that into a live countdown, 0 once it's past.
 */
export function useCountdown(retryAfterMs: number | undefined): number {
  const [deadline, setDeadline] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (retryAfterMs && retryAfterMs > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- capturing a one-shot deadline from a prop that changes with each rate-limit response, not a derived-state loop
      setDeadline(Date.now() + retryAfterMs);
    }
  }, [retryAfterMs]);

  useEffect(() => {
    if (!deadline) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the countdown when there's nothing to wait for
      setSecondsLeft(0);
      return;
    }
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0) setDeadline(null);
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [deadline]);

  return secondsLeft;
}
