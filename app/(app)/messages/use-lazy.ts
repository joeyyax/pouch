"use client";

import { useEffect, useRef, useState } from "react";

export type Lazy<T> = { state: "pending" } | { state: "loaded"; value: T } | { state: "failed" };

/** Loads once, the first time `when` is true. A null result counts as a failure. */
export function useLazy<T>(when: boolean, load: () => Promise<T | null>): Lazy<T> {
  const [result, setResult] = useState<Lazy<T>>({ state: "pending" });
  const started = useRef(false);
  useEffect(() => {
    if (!when || started.current) return;
    started.current = true;
    load().then(
      (value) => setResult(value === null ? { state: "failed" } : { state: "loaded", value }),
      () => setResult({ state: "failed" }),
    );
  }, [when, load]);
  return result;
}
