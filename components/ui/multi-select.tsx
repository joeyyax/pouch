"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { fieldClasses } from "@/components/ui/field";
import { ListboxPanel } from "@/components/ui/listbox-panel";
import { RemovableChip } from "@/components/ui/removable-chip";
import { useListbox } from "@/hooks/use-listbox";
import { cn } from "@/lib/utils";

export interface MultiSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

function defaultFilter(option: MultiSelectOption, query: string) {
  return option.label.toLowerCase().includes(query.toLowerCase());
}

// A tag-style multi-value picker: selected options render as RemovableChip
// tokens inline with a filter input, and the dropdown (a hand-floated
// cardVariants panel, not Radix Popover — a text input can't sit inside one
// without losing focus) stays open across picks so several options can be
// chosen in a row. Same aria-activedescendant combobox pattern jump-bar.tsx
// established, generalized through useListbox: the filter `<input>` is
// role="combobox" and owns real DOM focus the whole time the panel is
// open; the `<ul>` it describes via aria-activedescendant never takes focus
// itself.
export function MultiSelect({
  options,
  value,
  onValueChange,
  placeholder = "Select…",
  searchable = true,
  filter,
  maxSelected,
  shape = "cozy",
  size = "lg",
  id,
  name,
  invalid,
  "aria-invalid": ariaInvalid,
  disabled,
  className,
  "aria-describedby": ariaDescribedBy,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: {
  options: MultiSelectOption[];
  value: string[];
  onValueChange: (value: string[]) => void;
  placeholder?: string;
  searchable?: boolean;
  filter?: (option: MultiSelectOption, query: string) => boolean;
  maxSelected?: number;
  shape?: "cozy" | "compact" | "pill";
  size?: "sm" | "md" | "lg";
  id?: string;
  name?: string;
  invalid?: boolean;
  /** Accepted so Field can mark the control with the real ARIA
   * attribute instead of a bespoke prop. */
  "aria-invalid"?: boolean | "true" | "false";
  disabled?: boolean;
  className?: string;
  "aria-describedby"?: string;
  /** Names the input when no visible `<Label htmlFor>` points at it. The
   * placeholder can't stand in: it disappears as soon as anything is
   * selected, leaving the control nameless exactly when it has a value. */
  "aria-label"?: string;
  /** Names the input from existing visible text. */
  "aria-labelledby"?: string;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const listboxId = `${inputId}-listbox`;

  const isInvalid = invalid || ariaInvalid === true || ariaInvalid === "true";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = filter ?? defaultFilter;
  const isMaxed = maxSelected !== undefined && value.length >= maxSelected;

  const filteredOptions = useMemo(() => {
    if (!searchable || !query) return options;
    return options.filter((o) => matches(o, query));
  }, [options, query, searchable, matches]);

  const isOptionDisabled = useCallback(
    (i: number) => {
      const opt = filteredOptions[i];
      if (!opt) return true;
      if (opt.disabled) return true;
      return isMaxed && !value.includes(opt.value);
    },
    [filteredOptions, isMaxed, value],
  );

  const toggleOption = useCallback(
    (index: number) => {
      const opt = filteredOptions[index];
      if (!opt || opt.disabled) return;
      const selected = value.includes(opt.value);
      if (selected) {
        onValueChange(value.filter((v) => v !== opt.value));
      } else {
        if (isMaxed) return;
        onValueChange([...value, opt.value]);
      }
      setQuery("");
      inputRef.current?.focus();
    },
    [filteredOptions, value, onValueChange, isMaxed],
  );

  const { getOptionProps, onKeyDown, activeDescendant } = useListbox({
    itemCount: filteredOptions.length,
    activeIndex,
    setActiveIndex,
    onSelect: toggleOption,
    idBase: listboxId,
    onEscape: () => setOpen(false),
    isDisabled: isOptionDisabled,
  });

  // Close on outside click — Radix Popover would give this for free, but a
  // hand-floated panel has to hand-roll dismissal too.
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  function handleQueryChange(next: string) {
    setQuery(next);
    setOpen(true);
    const nextFiltered = !searchable || !next ? options : options.filter((o) => matches(o, next));
    setActiveIndex(nextFiltered.length > 0 ? 0 : -1);
  }

  function handleFocus() {
    if (disabled) return;
    setOpen(true);
    setActiveIndex((i) => (i >= 0 && i < filteredOptions.length ? i : filteredOptions.length > 0 ? 0 : -1));
  }

  function handleInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    if (e.key === "Backspace" && query === "" && value.length > 0) {
      e.preventDefault();
      onValueChange(value.slice(0, -1));
      return;
    }
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    onKeyDown(e);
  }

  return (
    <div ref={containerRef} className="relative">
      <div
        // The fade lives on this wrapper, so the chips inside look disabled
        // without being marked as such — which reads to a contrast checker as
        // ordinary text failing its ratio, and to assistive tech as an
        // ordinary control. Saying it explicitly fixes both.
        aria-disabled={disabled || undefined}
        className={cn(
          fieldClasses({ shape, size }),
          "flex w-full flex-wrap items-center gap-1.5 focus-within:ring-2 focus-within:ring-ring",
          isInvalid && "border-danger focus-within:ring-danger",
          disabled && "cursor-not-allowed opacity-50",
          className,
        )}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            inputRef.current?.focus();
          }
        }}
      >
        {value.map((v) => {
          // A value can outlive its option — a tag URL param that's aged out
          // of the current window, say. Falling back to the raw value keeps
          // it visible and removable instead of silently vanishing.
          const label = options.find((o) => o.value === v)?.label ?? v;
          return (
            <RemovableChip
              key={v}
              label={label}
              disabled={disabled}
              onRemove={() => {
                onValueChange(value.filter((val) => val !== v));
                inputRef.current?.focus();
              }}
            />
          );
        })}
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={open ? activeDescendant : undefined}
          aria-invalid={isInvalid || undefined}
          aria-describedby={ariaDescribedBy}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          disabled={disabled}
          readOnly={!searchable}
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          onFocus={handleFocus}
          onKeyDown={handleInputKeyDown}
          placeholder={value.length === 0 ? placeholder : ""}
          className="min-w-[6ch] flex-1 bg-transparent text-inherit outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
      </div>

      {/* FormData compatibility — one hidden input per selected value under the same name, so formData.getAll(name) works. */}
      {name ? value.map((v) => <input key={v} type="hidden" name={name} value={v} />) : null}

      <ListboxPanel
        open={open && !disabled}
        listboxId={listboxId}
        options={filteredOptions.map((opt, i) => ({
          key: opt.value,
          label: opt.label,
          selected: value.includes(opt.value),
          disabled: isOptionDisabled(i),
        }))}
        activeIndex={activeIndex}
        getOptionProps={getOptionProps}
        emptyMessage="No matches"
        multiselectable
      />
    </div>
  );
}
