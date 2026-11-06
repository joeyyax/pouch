"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { shortcutKey } from "@/lib/keyboard";

export interface Shortcut {
  /** Each entry is one key cap. Two entries read as alternatives: J or Down. */
  keys: string[];
  label: string;
}

export interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

// ShortcutSheet — what the keyboard can do here, on `?`. Mount it once per
// app; it listens on the window and lists whatever groups it's handed.
export function ShortcutSheet({
  groups,
  title = "Keyboard shortcuts",
  open: controlled,
  onOpenChange,
}: {
  groups: ShortcutGroup[];
  title?: string;
  /** Pass both to open it from a button as well. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = controlled ?? uncontrolled;
  const setOpen = onOpenChange ?? setUncontrolled;
  // There's no trigger for Radix to return to, so focus goes back to what had it.
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) return;
    const remember = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement) opener.current = event.target;
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, [open]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (shortcutKey(event) !== "?") return;
      event.preventDefault();
      if (!open && document.activeElement instanceof HTMLElement) opener.current = document.activeElement;
      setOpen(!open);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, setOpen]);

  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      title={title}
      size="sm"
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        if (opener.current?.isConnected) opener.current.focus();
      }}
    >
      <div className="flex flex-col gap-5">
        {groups.map((group) => (
          <section key={group.title} aria-label={group.title}>
            <p className="type-label mb-2 text-muted-foreground">{group.title}</p>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
              {group.shortcuts.map((shortcut) => (
                <div key={shortcut.label} className="col-span-2 grid grid-cols-subgrid items-center">
                  <dt className="text-foreground">{shortcut.label}</dt>
                  <dd className="flex items-center justify-end gap-1 text-muted-foreground">
                    {shortcut.keys.map((key, i) => (
                      <Fragment key={key}>
                        {i > 0 ? <span className="text-2xs">or</span> : null}
                        <kbd className="inline-flex min-w-6 items-center justify-center rounded-md border border-border bg-background-deep px-1.5 py-0.5 font-mono text-2xs text-foreground">
                          {key}
                        </kbd>
                      </Fragment>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
