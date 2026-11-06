"use client";

import { useActionState, useEffect, useRef } from "react";
import { idle, type ActionState } from "@/lib/dashboard/action-state";
import { toast } from "@/lib/toast";

/** Toasts both outcomes. The default, for a form whose only result is the sentence it returned. */
function toastOutcome(state: ActionState): void {
  if (state.status === "ok") toast({ title: state.message, variant: "success" });
  if (state.status === "error") toast({ title: state.message, variant: "error" });
}

/** Toasts the failure only, for a form that renders its own success in place. */
export function toastError(state: { status: string; message?: string }): void {
  if (state.status === "error" && state.message) toast({ title: state.message, variant: "error" });
}

/**
 * Binds a server action to a form and reports its outcome once. Toasts confirm; they don't
 * celebrate, so a success is the sentence the action returned and nothing more.
 *
 * `report` decides what an outcome is worth saying and runs any side effect that follows it,
 * once per outcome. Pass one when the state carries more than `ActionState` does, or when the
 * screen already shows the result.
 *
 * The ref is what makes "once" true: an effect that only depends on the state runs again
 * whenever React re-invokes effects on the same value — StrictMode does it on every mount —
 * and the operator sees the same confirmation twice. It's also what lets `report` be an inline
 * closure without a `useCallback` around it.
 */
export function useAction<S extends { status: string }>(
  action: (state: S, form: FormData) => Promise<S>,
  report: (state: S) => void = toastOutcome as (state: S) => void,
) {
  // Every state these actions return is a union that includes `idle`, and none of them is a
  // promise. The generic can say neither, so both casts stop here.
  const start = idle as Awaited<S>;
  const [state, formAction, pending] = useActionState<S, FormData>(action as (state: Awaited<S>, form: FormData) => Promise<S>, start);
  const reported = useRef<Awaited<S>>(start);

  useEffect(() => {
    if (reported.current === state) return;
    reported.current = state;
    report(state);
  }, [state, report]);

  return { state, formAction, pending };
}
