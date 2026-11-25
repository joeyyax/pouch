"use client";

import { createContext, useContext, type ReactNode } from "react";

/** What a Field tells the control inside it: the id its label points at, its message id and whether it's in error. */
export type FieldControlState = { id: string; describedBy?: string; invalid: boolean };

const FieldControlContext = createContext<FieldControlState | null>(null);

export function FieldControlProvider({ value, children }: { value: FieldControlState; children: ReactNode }) {
  return <FieldControlContext.Provider value={value}>{children}</FieldControlContext.Provider>;
}

/** The enclosing Field's wiring, or null outside one. For controls whose labelable element sits below the Field's child, such as SelectTrigger. */
export function useFieldControl() {
  return useContext(FieldControlContext);
}

/** Space-joined ids with blanks and repeats dropped. */
export function joinIds(...ids: (string | undefined)[]): string | undefined {
  const unique = [...new Set(ids.flatMap((value) => value?.split(/\s+/) ?? []).filter(Boolean))];
  return unique.length > 0 ? unique.join(" ") : undefined;
}
