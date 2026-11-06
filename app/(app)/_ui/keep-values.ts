import { startTransition, type FormEvent } from "react";

/**
 * Submits through `onSubmit` instead of `action`, so React doesn't reset the form afterward and a
 * rejected value stays in its field to fix.
 */
export function keepValues(dispatch: (form: FormData) => void, extra?: Record<string, string>) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    for (const [name, value] of Object.entries(extra ?? {})) form.set(name, value);
    startTransition(() => dispatch(form));
  };
}
