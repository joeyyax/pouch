"use client";

import { useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { shortcutKey } from "@/lib/keyboard";

// Controls inside a row. The row is the one stop, so these leave the tab order and are reached
// with Left and Right instead.
const TABBABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
const CONTROL = "data-row-control";

/** A row's controls in reading order, skipping any a fold or media query hides. */
function controlsOf(row: HTMLElement) {
  return [...row.querySelectorAll<HTMLElement>(`[${CONTROL}]`)].filter((el) => el.getClientRects().length > 0);
}

/**
 * A roving tabindex over a list of rows (the WAI-ARIA grid pattern, with focus on rows).
 *
 * One row is in the tab order: the one last focused, else `activeKey`, else the first. Tab enters
 * there and Tab again leaves. Up and Down move a row, Home and End jump to either end, Enter and
 * Space call `onOpen`. Controls inside a row drop out of the tab order, so Tab never stops
 * between rows: Right and Left walk them, and Escape or Left past the first returns to the row.
 */
export function useRowNavigation({
  keys,
  activeKey,
  onOpen,
}: {
  /** Row keys in display order. */
  keys: string[];
  /** The open row. The tab stop follows it, so stepping a detail moves where Tab lands. */
  activeKey?: string;
  onOpen?: (key: string) => void;
}) {
  const [focusKey, setFocusKey] = useState<string>();
  const nodes = useRef(new Map<string, HTMLElement>());

  const [seenActive, setSeenActive] = useState(activeKey);
  if (activeKey !== seenActive) {
    setSeenActive(activeKey);
    if (activeKey) setFocusKey(activeKey);
  }

  const stop =
    focusKey && keys.includes(focusKey) ? focusKey : activeKey && keys.includes(activeKey) ? activeKey : keys[0];

  useLayoutEffect(() => {
    const quiet = () => {
      for (const row of nodes.current.values()) {
        for (const el of row.querySelectorAll<HTMLElement>(TABBABLE)) {
          el.tabIndex = -1;
          el.setAttribute(CONTROL, "");
        }
      }
    };
    quiet();
    // A tooltip trigger or copy button mounted later joins the tab order otherwise.
    const observer = new MutationObserver(quiet);
    for (const row of nodes.current.values()) observer.observe(row, { childList: true, subtree: true });
    return () => observer.disconnect();
  });

  function move(from: string, to: "previous" | "next" | "first" | "last") {
    const index = keys.indexOf(from);
    const target =
      to === "first"
        ? keys[0]
        : to === "last"
          ? keys.at(-1)
          : keys[Math.min(keys.length - 1, Math.max(0, index + (to === "next" ? 1 : -1)))];
    if (!target) return;
    setFocusKey(target);
    nodes.current.get(target)?.focus();
  }

  function getRowProps(key: string) {
    return {
      ref: (node: HTMLElement | null) => {
        if (node) nodes.current.set(key, node);
        else nodes.current.delete(key);
      },
      "data-row-key": key,
      tabIndex: key === stop ? 0 : -1,
      onFocus: (event: FocusEvent<HTMLElement>) => {
        if (event.currentTarget.contains(event.target)) setFocusKey(key);
      },
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        const row = event.currentTarget;
        const target = event.target;
        // React bubbles events from portals too: a popover opened from a row isn't in it.
        if (!(target instanceof HTMLElement) || !row.contains(target)) return;
        const pressed = shortcutKey(event);
        if (pressed === "ArrowRight" || pressed === "ArrowLeft") {
          const controls = controlsOf(row);
          const at = target === row ? -1 : controls.indexOf(target);
          const next = pressed === "ArrowRight" ? controls[at + 1] : at === 0 ? row : controls[at - 1];
          if (!next) return;
          event.preventDefault();
          next.focus();
          return;
        }
        if (target !== row && pressed === "Escape") {
          event.preventDefault();
          row.focus();
          return;
        }
        const to =
          pressed === "ArrowDown"
            ? "next"
            : pressed === "ArrowUp"
              ? "previous"
              : pressed === "Home"
                ? "first"
                : pressed === "End"
                  ? "last"
                  : null;
        if (to) {
          event.preventDefault();
          move(key, to);
        } else if (target === row && onOpen && (pressed === "Enter" || pressed === " ")) {
          event.preventDefault();
          onOpen(key);
        }
      },
    };
  }

  return { getRowProps };
}

/** What `getRowProps` spreads onto a row: the tab stop, its keys and `data-row-key`. */
export type RowProps = ReturnType<ReturnType<typeof useRowNavigation>["getRowProps"]>;

/** The keys either side of `key`, for stepping an open detail through the list. */
export function adjacentKeys(keys: string[], key: string | undefined) {
  const index = key === undefined ? -1 : keys.indexOf(key);
  if (index === -1) return { previous: undefined, next: undefined };
  return { previous: keys[index - 1], next: keys[index + 1] };
}
