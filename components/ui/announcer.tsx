"use client";

import { useSyncExternalStore } from "react";
import { getAnnouncement, getServerAnnouncement, subscribeAnnouncements } from "@/lib/announce";

/** The page's one polite live region, in the root layout. Don't put live regions in streamed sections: a modal open on load marks around them before they hydrate. */
export function Announcer() {
  const { id, text } = useSyncExternalStore(subscribeAnnouncements, getAnnouncement, getServerAnnouncement);
  return (
    <div aria-live="polite" className="sr-only">
      <span key={id}>{text}</span>
    </div>
  );
}
