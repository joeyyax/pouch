import { createStore } from "@/lib/create-store";
import { track } from "@/lib/track";

export type ToastVariant = "default" | "success" | "error";

export interface ToastItem {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
  duration: number;
}

const EMPTY: ToastItem[] = [];
const store = createStore<ToastItem[]>(EMPTY, EMPTY);
let nextId = 1;

export const subscribeToasts = store.subscribe;
export const getToasts = store.get;
export const getServerToasts = store.getServer;

export function dismissToast(id: number) {
  store.set((toasts) => toasts.filter((t) => t.id !== id));
}

/** Rewrites a live toast in place — for a pending action that resolves
 * ("Saving…" → "Saved"). A no-op once the toast has dismissed itself. */
export function updateToast(
  id: number,
  patch: Partial<Omit<ToastItem, "id">>,
) {
  store.set((toasts) =>
    toasts.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  );
}

export function toast(input: {
  title: string;
  description?: string;
  variant?: ToastVariant;
  duration?: number;
}): number {
  const id = nextId++;
  store.set((toasts) => [
    ...toasts,
    {
      id,
      title: input.title,
      description: input.description,
      variant: input.variant ?? "default",
      duration: input.duration ?? 5000,
    },
  ]);
  track("toast_shown", { title: input.title, variant: input.variant ?? "default" });
  return id;
}
