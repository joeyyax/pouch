"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { track } from "@/lib/track";

const RESET_MS = 2000;

export type CopyState = "idle" | "copied" | "failed";

/** Copies text to the clipboard, holding the result for RESET_MS so a caller
 * can swap an icon/label — the icon-swap-then-revert pattern used anywhere a
 * copy button shows up (Terminal, the "git clone" card, …). A denied
 * clipboard reports "failed" rather than looking like nothing happened. */
export function useCopyToClipboard() {
  const [state, setState] = useState<CopyState>("idle");
  const resetTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(resetTimeout.current), []);

  const copy = useCallback(async (text: string) => {
    clearTimeout(resetTimeout.current);
    let ok = true;
    try {
      await navigator.clipboard.writeText(text);
      track("clipboard_copy");
    } catch {
      ok = false;
    }
    setState(ok ? "copied" : "failed");
    resetTimeout.current = setTimeout(() => setState("idle"), RESET_MS);
    return ok;
  }, []);

  return { state, copied: state === "copied", failed: state === "failed", copy };
}
