import { createStore } from "@/lib/create-store";

export interface Announcement {
  id: number;
  text: string;
}

const EMPTY: Announcement = { id: 0, text: "" };
const store = createStore<Announcement>(EMPTY, EMPTY);

export const subscribeAnnouncements = store.subscribe;
export const getAnnouncement = store.get;
export const getServerAnnouncement = store.getServer;

/** Speaks `text` through the page's one polite live region. */
export function announce(text: string): void {
  store.set((previous) => ({ id: previous.id + 1, text }));
}
