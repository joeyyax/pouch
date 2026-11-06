"use client";

import { useEffect, useState } from "react";

/** The app header's height, so a sticky heading sits under it rather than behind it. */
export function useHeaderOffset(): number {
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const header = document.querySelector("main")?.previousElementSibling;
    if (!(header instanceof HTMLElement) || header.tagName !== "HEADER") return;
    const observer = new ResizeObserver(() => setOffset(header.offsetHeight));
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  return offset;
}
