"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

// Optional-chained for environments without matchMedia, such as jsdom.
function subscribe(onChange: () => void) {
  const mq = window.matchMedia?.(QUERY);
  mq?.addEventListener("change", onChange);
  return () => mq?.removeEventListener("change", onChange);
}

const getSnapshot = () => window.matchMedia?.(QUERY).matches ?? false;
const getServerSnapshot = () => null;

/** Reduced-motion preference: null on the server and through hydration, then live. Start motion only on `false`. */
export function useReducedMotionSafe(): boolean | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
