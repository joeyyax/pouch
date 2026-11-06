"use client";

import { keepValues } from "../../../_ui/keep-values";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { TextLink } from "@/components/ui/text-link";
import type { DefaultProviderView } from "@/lib/dashboard/admin-general";
import { SectionHeader } from "../../../_ui/section-header";
import { useAction } from "../../../_ui/use-action";
import { setDefaultProviderAction } from "./actions";

/** Radix refuses an empty item value, so "no default" travels as a sentinel and submits as blank. */
const NONE = "__none__";

export function DefaultProviderCard({ view }: { view: DefaultProviderView }) {
  const save = useAction(setDefaultProviderAction);
  const [providerId, setProviderId] = useState(view.selectedId ?? NONE);

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        title="Default provider"
        description="The shared provider new organizations start on."
      />
      <Card className="flex flex-col gap-4 p-5">
        {view.options.length === 0 ? (
          <p className="type-body-sm text-muted-foreground">
            No shared providers yet, so new organizations wait for an admin to assign one. Add one in{" "}
            <TextLink href="/admin/settings/providers">Providers</TextLink>.
          </p>
        ) : (
          <form onSubmit={keepValues(save.formAction)} className="flex flex-col gap-4">
            <Field
              id="providerId"
              label="New organizations get"
              hint="Without one, new organizations can't add a domain until an admin assigns a provider."
              error={save.state.status === "error" ? save.state.message : undefined}
            >
              <input type="hidden" name="providerId" value={providerId === NONE ? "" : providerId} />
              <Select
                id="providerId"
                items={[
                  { value: NONE, label: "No provider" },
                  ...view.options.map((option) => ({
                    value: option.id,
                    label: `${option.name} · ${option.adapterLabel} · ${option.organizationCount} ${option.organizationCount === 1 ? "organization" : "organizations"}`,
                  })),
                ]}
                value={providerId}
                onValueChange={setProviderId}
                size="md"
                shape="compact"
                triggerClassName="max-w-lg"
              />
            </Field>
            <div>
              <Button type="submit" size="md" loading={save.pending}>
                Save
              </Button>
            </div>
          </form>
        )}
      </Card>
    </section>
  );
}
