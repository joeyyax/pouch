import { Field, fieldClasses } from "@/components/ui/field";
import type { CredentialFieldSpec } from "@/lib/dashboard/views/service";

const inputClass = `${fieldClasses({ shape: "compact", size: "md" })} w-full font-mono`;

/** An adapter's credential fields, always blank. Stored values are never shown back. */
export function CredentialFields({ specs, idPrefix }: { specs: CredentialFieldSpec[]; idPrefix: string }) {
  if (specs.length === 0) {
    return <p className="type-body-sm text-muted-foreground">This adapter takes no credentials.</p>;
  }

  return (
    <>
      {specs.map((spec) => (
        <Field
          key={spec.name}
          id={`${idPrefix}-${spec.name}`}
          label={<code className="font-mono">{spec.name}</code>}
          required={spec.required}
          hint={spec.description}
        >
          <input
            id={`${idPrefix}-${spec.name}`}
            name={`cred_${spec.name}`}
            type="password"
            autoComplete="off"
            required={spec.required}
            className={inputClass}
          />
        </Field>
      ))}
    </>
  );
}
