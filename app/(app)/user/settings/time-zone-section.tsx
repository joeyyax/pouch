"use client";

import { startTransition, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, fieldClasses } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { ListboxPanel } from "@/components/ui/listbox-panel";
import type { TimeZoneOption } from "@/lib/dashboard/user-settings";
import { zoneName } from "@/lib/time-zone";
import { useListbox } from "@/hooks/use-listbox";
import { cn } from "@/lib/utils";
import { useAction } from "../../_ui/use-action";
import { updateTimeZoneAction } from "./actions";

/** The browser's zone when it isn't `saved`, compared the way the browser spells both. The server resolves aliases on save. */
function browserZoneUnlike(saved: string): string | null {
  try {
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const same = new Intl.DateTimeFormat("en-US", { timeZone: saved }).resolvedOptions().timeZone === browser;
    return browser && !same ? browser : null;
  } catch {
    return null;
  }
}

function matches(option: TimeZoneOption, query: string): boolean {
  const needle = query.trim().toLowerCase().replaceAll("_", " ");
  return option.label.toLowerCase().includes(needle) || option.aliases.some((alias) => alias.includes(needle));
}

export function TimeZoneSection({ saved, options }: { saved: string; options: TimeZoneOption[] }) {
  const update = useAction(updateTimeZoneAction);
  const id = useId();
  const listboxId = `${id}-listbox`;
  const labelOf = (zone: string) => options.find((option) => option.value === zone)?.label ?? zoneName(zone);

  const [value, setValue] = useState(saved);
  const [text, setText] = useState(() => labelOf(saved));
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [browser, setBrowser] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // Read after mount: the server doesn't know the browser's zone, and a guess would mismatch.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the browser's zone only exists on the client
    setBrowser(browserZoneUnlike(saved));
  }, [saved]);

  const filtered = useMemo(
    () => (open && text !== labelOf(value) ? options.filter((option) => matches(option, text)) : options),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options, text, value, open],
  );

  function choose(index: number) {
    const option = filtered[index];
    if (!option) return;
    setValue(option.value);
    setText(option.label);
    setOpen(false);
  }

  function reset() {
    setText(labelOf(value));
    setOpen(false);
  }

  const { getOptionProps, onKeyDown, activeDescendant } = useListbox({
    itemCount: filtered.length,
    activeIndex,
    setActiveIndex,
    onSelect: choose,
    idBase: listboxId,
    onEscape: reset,
  });

  useEffect(() => {
    if (!open) return;
    function outside(event: MouseEvent) {
      if (!container.current?.contains(event.target as Node)) reset();
    }
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, value]);

  function save(zone: string) {
    const form = new FormData();
    form.set("timeZone", zone);
    startTransition(() => update.formAction(form));
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setOpen(true);
      setActiveIndex(Math.max(0, filtered.findIndex((option) => option.value === value)));
      return;
    }
    if (open) onKeyDown(event);
    else if (event.key === "Enter") {
      event.preventDefault();
      if (value !== saved) save(value);
    }
  }

  const error = update.state.status === "error" && update.state.field === "timeZone" ? update.state.message : undefined;

  return (
    <Card className="p-5">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save(value);
        }}
        className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-6"
      >
        <Field
          id={id}
          label="Time zone"
          hint="Dates, day headings and daily charts use it. The API answers in UTC."
          error={error}
          className="w-full max-w-sm"
        >
          <div ref={container} className="relative">
            <Icon name="search" className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={input}
              id={id}
              type="text"
              role="combobox"
              aria-expanded={open}
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={open ? activeDescendant : undefined}
              autoComplete="off"
              spellCheck={false}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setOpen(true);
                setActiveIndex(0);
              }}
              onFocus={(event) => {
                event.currentTarget.select();
                setOpen(true);
                setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
              }}
              onKeyDown={keyDown}
              className={cn(fieldClasses({ shape: "compact", size: "md" }), "w-full pl-10")}
            />
            <ListboxPanel
              open={open}
              listboxId={listboxId}
              options={filtered.map((option) => ({
                key: option.value,
                label: option.label,
                selected: option.value === value,
                disabled: false,
              }))}
              activeIndex={activeIndex}
              getOptionProps={getOptionProps}
              emptyMessage={`No time zone matches “${text.trim()}”. Try a city, like Chicago.`}
            />
          </div>
        </Field>
        <Button type="submit" size="md" loading={update.pending} disabled={value === saved} className="shrink-0">
          Save time zone
        </Button>
      </form>
      {browser ? (
        <p className="type-body-sm mt-4 text-muted-foreground">
          <button
            type="button"
            disabled={update.pending}
            onClick={() => save(browser)}
            className="rounded-sm font-semibold text-primary-strong underline underline-offset-2 hover:text-primary disabled:opacity-50"
          >
            Use my browser&apos;s time zone ({zoneName(browser)})
          </button>
        </p>
      ) : null}
    </Card>
  );
}
