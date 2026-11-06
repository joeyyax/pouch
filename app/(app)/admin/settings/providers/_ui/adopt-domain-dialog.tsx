"use client";

import { keepValues } from "../../../../_ui/keep-values";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field, fieldClasses } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { idle } from "@/lib/dashboard/action-state";
import { adoptDomainAction, type AdoptDomainState } from "../actions";

export function AdoptDomainDialog({
  provider,
  organization,
  onClose,
}: {
  provider: { id: string; adapterLabel: string };
  organization: { id: string; name: string; assignmentId: string };
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState<AdoptDomainState, FormData>(adoptDomainAction, idle);
  const error = state.status === "error" ? state : null;

  return (
    <Modal
      open
      onOpenChange={(open) => !open && !pending && onClose()}
      title={`Adopt a domain for ${organization.name}`}
      description={`Takes over a domain that already exists at ${provider.adapterLabel}. It keeps its signing keys, so the published records keep working.`}
    >
      <form onSubmit={keepValues(formAction)} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={provider.id} />
        <input type="hidden" name="organizationId" value={organization.id} />
        <input type="hidden" name="organizationName" value={organization.name} />
        <input type="hidden" name="providerId" value={organization.assignmentId} />

        <ul className="type-body-sm flex list-disc flex-col gap-1 pl-5 text-foreground-soft">
          <li>A domain the provider holds for another organization is refused.</li>
          <li>Organizations can&apos;t adopt. Adding the same domain still reads as unavailable.</li>
        </ul>

        <Field id="adopt-domain" label="Domain" hint="It has to already exist at the provider." error={error?.message}>
          <input
            id="adopt-domain"
            name="name"
            placeholder="example.com"
            required
            maxLength={253}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            className={`${fieldClasses({ shape: "compact", size: "md" })} w-full`}
          />
        </Field>

        {state.status === "adopted" ? (
          <Callout tone="success" title={`${state.name} adopted`}>
            {state.organizationName} sends from it now.{" "}
            {state.verified
              ? "The provider already verifies it, so nothing needs publishing."
              : "It reads pending until the provider confirms its records."}
          </Callout>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          {state.status === "adopted" ? (
            <Button type="button" size="md" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button type="button" variant="secondary" size="md" disabled={pending} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" size="md" loading={pending}>
                Adopt
              </Button>
            </>
          )}
        </div>
      </form>
    </Modal>
  );
}
