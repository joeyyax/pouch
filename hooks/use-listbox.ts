"use client";

import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

// Generalizes the keyboard/active-descendant logic jump-bar.tsx hand-rolled
// for its own <ul>: Arrow/Home/End move a highlighted index, Enter commits
// it, Escape backs out — all wired through aria-activedescendant instead of
// moving real DOM focus per option. jump-bar owns a focusable <ul> itself
// (the listbox IS the focus-holding element), but the combobox pattern
// MultiSelect/Combobox need instead keeps focus in a text `<input
// role="combobox">` and only *describes* the active option via
// aria-activedescendant — so unlike jump-bar, `onKeyDown` here is meant to
// be attached to that input, not to the `<ul>`. The `<ul>` itself only needs
// `listboxProps` (id + role) so `aria-controls` on the input can target it.

export interface UseListboxOptions {
  /** Number of options currently rendered (post-filter/post-fetch). */
  itemCount: number;
  /** Index of the option currently "active" — the aria-activedescendant target. */
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  /** Enter (or a pointer selection via getOptionProps) commits this index. */
  onSelect: (index: number) => void;
  /** Every id this hook mints is derived from this: `${idBase}-option-${i}`, and it doubles as the `<ul>` id. */
  idBase: string;
  /** Arrow navigation wraps past the first/last option. Defaults to true. */
  loop?: boolean;
  /** Escape — typically "close the panel". Omit for a listbox that's always open. */
  onEscape?: () => void;
  /** Marks an index as unreachable by keyboard (still rendered, just skipped by Arrow/Home/End and ignored by Enter). */
  isDisabled?: (index: number) => boolean;
}

export interface UseListboxResult {
  /** Spread onto the `<ul role="listbox">`. */
  listboxProps: { id: string; role: "listbox" };
  /** Spread onto each `<li>` — id, role, aria-selected, hover-to-activate, click-to-select. */
  getOptionProps: (
    index: number,
    selected?: boolean,
  ) => {
    id: string;
    role: "option";
    "aria-selected": boolean;
    "aria-disabled": true | undefined;
    onMouseEnter: () => void;
    onMouseDown: (e: ReactMouseEvent) => void;
  };
  /** Attach to the focus-holding combobox `<input>` — handles Arrow/Home/End/Enter/Escape. */
  onKeyDown: (e: ReactKeyboardEvent) => void;
  /** Current `aria-activedescendant` value — put this on the same element `onKeyDown` is attached to. */
  activeDescendant: string | undefined;
}

export function useListbox({
  itemCount,
  activeIndex,
  setActiveIndex,
  onSelect,
  idBase,
  loop = true,
  onEscape,
  isDisabled,
}: UseListboxOptions): UseListboxResult {
  const disabledAt = useCallback((i: number) => isDisabled?.(i) ?? false, [isDisabled]);

  // Steps from `from` in `dir`, skipping disabled options, wrapping (or
  // clamping) at the ends. Falls back to `from` if every option is disabled.
  const step = useCallback(
    (from: number, dir: 1 | -1): number => {
      if (itemCount === 0) return -1;
      let next = from;
      for (let n = 0; n < itemCount; n++) {
        next += dir;
        if (loop) {
          next = ((next % itemCount) + itemCount) % itemCount;
        } else {
          if (next < 0 || next > itemCount - 1) return from;
          next = Math.min(Math.max(next, 0), itemCount - 1);
        }
        if (!disabledAt(next)) return next;
      }
      return from;
    },
    [itemCount, loop, disabledAt],
  );

  const firstEnabled = useCallback(() => {
    for (let i = 0; i < itemCount; i++) if (!disabledAt(i)) return i;
    return -1;
  }, [itemCount, disabledAt]);

  const lastEnabled = useCallback(() => {
    for (let i = itemCount - 1; i >= 0; i--) if (!disabledAt(i)) return i;
    return -1;
  }, [itemCount, disabledAt]);

  // Real focus never moves, so nothing scrolls the active option into view on
  // its own — arrowing down a long list walked the highlight off the bottom
  // and left it there. Only keyboard moves scroll: a mouse already knows where
  // it is, and scrolling under the pointer moves the list out from under it.
  const byKeyboard = useRef(false);

  useEffect(() => {
    if (!byKeyboard.current) return;
    if (activeIndex < 0 || activeIndex >= itemCount) return;
    document
      .getElementById(`${idBase}-option-${activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, itemCount, idBase]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          byKeyboard.current = true;
          setActiveIndex(step(activeIndex, 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          byKeyboard.current = true;
          setActiveIndex(step(activeIndex, -1));
          break;
        case "Home":
          if (itemCount === 0) break;
          e.preventDefault();
          byKeyboard.current = true;
          setActiveIndex(firstEnabled());
          break;
        case "End":
          if (itemCount === 0) break;
          e.preventDefault();
          byKeyboard.current = true;
          setActiveIndex(lastEnabled());
          break;
        case "Enter":
          if (activeIndex < 0 || activeIndex >= itemCount || disabledAt(activeIndex)) break;
          e.preventDefault();
          onSelect(activeIndex);
          break;
        case "Escape":
          if (!onEscape) break;
          e.preventDefault();
          onEscape();
          break;
        default:
          break;
      }
    },
    [activeIndex, itemCount, step, firstEnabled, lastEnabled, onSelect, onEscape, disabledAt, setActiveIndex],
  );

  const getOptionProps = useCallback(
    (index: number, selected = false) => ({
      id: `${idBase}-option-${index}`,
      role: "option" as const,
      "aria-selected": selected,
      "aria-disabled": disabledAt(index) ? (true as const) : undefined,
      onMouseEnter: () => {
        if (disabledAt(index)) return;
        byKeyboard.current = false;
        setActiveIndex(index);
      },
      // mousedown (not click) + preventDefault so selecting an option never
      // blurs the input first — the input has to stay focused the whole
      // time the panel is open.
      onMouseDown: (e: ReactMouseEvent) => {
        e.preventDefault();
        if (!disabledAt(index)) onSelect(index);
      },
    }),
    [idBase, disabledAt, setActiveIndex, onSelect],
  );

  return {
    listboxProps: { id: idBase, role: "listbox" },
    getOptionProps,
    onKeyDown,
    activeDescendant: activeIndex >= 0 && activeIndex < itemCount ? `${idBase}-option-${activeIndex}` : undefined,
  };
}
