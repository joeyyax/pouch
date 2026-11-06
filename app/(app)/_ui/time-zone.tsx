"use client";

import { createContext, useContext } from "react";
import { UTC } from "@/lib/time-zone";

const TimeZoneContext = createContext<string>(UTC);

/** The signed-in person's zone, from the server session, for every date the client formats. */
export function TimeZoneProvider({ zone, children }: { zone: string; children: React.ReactNode }) {
  return <TimeZoneContext value={zone}>{children}</TimeZoneContext>;
}

export function useTimeZone(): string {
  return useContext(TimeZoneContext);
}
