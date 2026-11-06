"use client";

import { useEffect, useRef, type MouseEvent, type RefObject } from "react";

/**
 * Returns focus to the control that opened a dialog.
 *
 * Radix aims focus at the node it saw focused when the dialog opened. In a tree that re-renders
 * between the click and the close — the open state living in the URL, say — that node can be
 * detached by the time the dialog closes, and focus lands on `<body>`. `remember` catches the
 * element at click time; `restore` goes on the dialog's `onCloseAutoFocus` so it runs in place of
 * Radix's own attempt rather than racing it.
 *
 * `fallback` takes focus when the opener is gone, which is what happens when the confirmed
 * action removes the button that opened the dialog.
 */
export function useOpenerFocus(fallback?: RefObject<HTMLElement | null>) {
  const opener = useRef<HTMLElement | null>(null);

  function remember(event: MouseEvent<HTMLElement>) {
    opener.current = event.currentTarget;
  }

  function restore(event?: Event) {
    event?.preventDefault();
    const target = opener.current;
    opener.current = null;
    const next = target?.isConnected ? target : fallback?.current;
    next?.focus();
  }

  return { remember, restore };
}

/**
 * Moves focus to the element once, on mount. For a view that replaces the one that opened it —
 * a form, a panel showing a secret — where there is no control left to return to.
 */
export function useFocusOnMount<T extends HTMLElement>(active = true) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;
    const timer = setTimeout(() => node.focus(), 0);
    return () => clearTimeout(timer);
  }, [active]);

  return ref;
}
