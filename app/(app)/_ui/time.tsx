"use client";

import { useEffect, useState } from "react";
import { timeLabel, zonedTime } from "@/lib/format/time";
import { useTimeZone } from "./time-zone";

/**
 * Relative under 24 hours, absolute after in the viewer's zone, exact time and zone on hover. Re-labels itself as it
 * ages, so a list left open doesn't keep claiming a message arrived four minutes ago.
 * The server renders its own label from its own clock; a one-word disagreement at a
 * boundary is not worth a hydration error.
 */
export function Time({ date, className }: { date: Date; className?: string }) {
  const zone = useTimeZone();
  const time = date.getTime();
  const [label, setLabel] = useState(() => timeLabel(date, zone));

  useEffect(() => {
    const relabel = () => setLabel(timeLabel(new Date(time), zone));
    relabel();
    const timer = setInterval(relabel, 30_000);
    return () => clearInterval(timer);
  }, [time, zone]);

  return (
    <time
      dateTime={date.toISOString()}
      title={zonedTime(date, zone)}
      className={className}
      suppressHydrationWarning
    >
      {label}
    </time>
  );
}
