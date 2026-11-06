interface KeyLike {
  key: string;
  target: EventTarget | null;
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/** A text field, a select or anything contenteditable has the caret. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
    target.closest('[contenteditable]:not([contenteditable="false"])') !== null
  );
}

// Widgets that own their arrow keys.
const OWNS_ARROWS = '[role="listbox"], [role="menu"], [role="menubar"], [role="tree"], [role="slider"], [role="radiogroup"], [role="combobox"], [role="spinbutton"]';

/**
 * The key a shortcut may act on, or null. Null while typing, with Ctrl, Cmd or Alt held, inside a
 * widget that uses arrows itself, or when something nearer already handled the event. Shift is
 * allowed: `?` needs it.
 */
export function shortcutKey(event: KeyLike): string | null {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return null;
  if (isTypingTarget(event.target)) return null;
  if (event.target instanceof Element && event.target.closest(OWNS_ARROWS)) return null;
  return event.key;
}
