"use client";

import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { KeyDomainOption } from "@/lib/dashboard/views/keys";

/** Every domain, or a checked list of them. Submits `domainIds`, empty for every domain. */
export function DomainScopeField({
  id,
  domainOptions,
  initialIds = [],
  error,
}: {
  id: string;
  domainOptions: KeyDomainOption[];
  initialIds?: string[];
  error?: string;
}) {
  const [scope, setScope] = useState<"all" | "specific">(initialIds.length === 0 ? "all" : "specific");

  if (domainOptions.length === 0) {
    return (
      <Field id={id} label="Domains" error={error}>
        <p id={id} className="type-body-sm text-muted-foreground">
          No domains yet. It sends from every domain you add.
        </p>
      </Field>
    );
  }

  return (
    <Field
      id={id}
      label="Domains"
      hint={scope === "all" ? "Includes domains added later." : undefined}
      error={error}
    >
      <div id={id} className="flex flex-col gap-3">
        <input type="hidden" name="domainScope" value={scope} />
        <RadioGroup
          value={scope}
          onValueChange={(value) => setScope(value as "all" | "specific")}
          className="flex flex-col gap-2"
          aria-label="Domain scope"
        >
          <label className="flex items-center gap-2 type-body-sm text-foreground">
            <RadioGroupItem id={`${id}-all`} value="all" />
            Every domain
          </label>
          <label className="flex items-center gap-2 type-body-sm text-foreground">
            <RadioGroupItem id={`${id}-specific`} value="specific" />
            Only these
          </label>
        </RadioGroup>
        {scope === "specific" ? (
          <fieldset className="flex flex-col gap-2 border-l border-border pl-4">
            <legend className="sr-only">Domains this key can send from</legend>
            {domainOptions.map((domain) => (
              <label key={domain.id} className="flex min-w-0 items-center gap-2 type-body-sm text-foreground">
                <Checkbox name="domainIds" value={domain.id} defaultChecked={initialIds.includes(domain.id)} />
                <span className="min-w-0 break-all font-mono">{domain.name}</span>
                {domain.verified ? null : <span className="shrink-0 text-muted-foreground">not verified</span>}
              </label>
            ))}
          </fieldset>
        ) : null}
      </div>
    </Field>
  );
}
