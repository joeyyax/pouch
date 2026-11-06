import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { cva } from "class-variance-authority";
import { FieldMessage } from "@/components/ui/field-message";
import { Label } from "@/components/ui/label";

// The one input recipe — every text input/textarea/select trigger on the
// site shares this core (border, ground, focus ring, aria-invalid error
// state); `shape` (radius + horizontal padding) and `size` (vertical padding
// + text scale) are independent axes so real height variance is possible
// without fighting shape's own spacing. No wrapper component: inputs,
// textareas and their props diverge enough that composing via className
// reads more plainly.
export const fieldClasses = cva(
  // Placeholder at full --muted-foreground, not /60. The faded version
  // measured 2.38:1 on the page ground and 2.46:1 on a card, against the 4.5:1
  // placeholder text has to meet; full strength is 5.44:1 and still reads
  // clearly lighter than entered text, which is --foreground at ~13:1.
  "border border-border bg-background text-foreground outline-none transition-shadow placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-danger aria-invalid:focus-visible:ring-danger disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      shape: {
        cozy: "squircle rounded-2xl px-5",
        compact: "squircle rounded-xl px-4",
        pill: "rounded-full px-5",
      },
      size: {
        sm: "py-2 text-sm",
        md: "py-3 text-15",
        lg: "py-3.5 text-15",
      },
    },
    defaultVariants: { shape: "cozy", size: "lg" },
  },
);

// Glues Label + FieldMessage around whatever field the caller writes —
// `children` stays a plain <input>/<textarea> (or a controlled field like
// MultiSelect/Combobox) authored directly by the caller (matching id +
// fieldClasses className), rather than this component branching on an
// `as` prop: the recipe above already settled that inputs/textareas
// diverge enough that composing via className reads more plainly than a
// polymorphic wrapper. This only dedupes the label/hint/error layout
// around that field.
//
// The one bit of real wiring: when there's a hint or error, its id
// (`${id}-msg`) lands on the FieldMessage and gets cloned onto the field
// child's aria-describedby (merged with anything already there); an `error`
// additionally clones on aria-invalid (for a plain input/textarea) and
// `invalid` (for components like MultiSelect/Combobox that take that as a
// prop instead of an ARIA attribute — either the field reads it or it's a
// harmless unused prop).
export function Field({
  id,
  label,
  required,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const message = error ?? hint;
  const msgId = message ? `${id}-msg` : undefined;

  // Only `aria-invalid`, never a bare `invalid`. A real ARIA attribute is safe
  // on anything — a host element takes it directly, and a component that
  // spreads unknown props onto the DOM passes it through correctly. Cloning
  // `invalid` instead meant guessing which children read it as a prop, and the
  // guess was wrong for Radix's Checkbox, Switch and RadioGroupItem: they
  // spread it to the button and React logged an unknown-attribute warning.
  const field = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        "aria-describedby": joinIds((children.props as Record<string, unknown>)["aria-describedby"], msgId),
        ...(error ? { "aria-invalid": true } : {}),
      })
    : children;

  return (
    <div className={className}>
      <Label htmlFor={id} required={required}>
        {label}
      </Label>
      {field}
      {error ? (
        <FieldMessage id={msgId} tone="error">
          {error}
        </FieldMessage>
      ) : hint ? (
        <FieldMessage id={msgId} tone="hint">
          {hint}
        </FieldMessage>
      ) : null}
    </div>
  );
}

function joinIds(existing: unknown, extra: string | undefined): string | undefined {
  const ids = [typeof existing === "string" ? existing : undefined, extra].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}