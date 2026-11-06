"use client";

import { keepValues } from "../../../../_ui/keep-values";
import Link from "next/link";
import { useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field, fieldClasses } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useAction } from "../../../../_ui/use-action";
import { Select } from "@/components/ui/select";
import type { AdminProviderOrganization, AdminAdapterOption } from "@/lib/dashboard/admin-providers";
import { createProviderAction, type CredentialWriteState } from "../actions";
import { CredentialFields } from "./credential-fields";
import { VerificationResult } from "./verification-result";

const inputClass = `${fieldClasses({ shape: "compact", size: "md" })} w-full`;

export function AddProviderDialog({
  adapters,
  organizations,
  onClose,
}: {
  adapters: AdminAdapterOption[];
  organizations: AdminProviderOrganization[];
  onClose: () => void;
}) {
  // Errors show in the dialog, so nothing is toasted.
  const { state, formAction, pending } = useAction<CredentialWriteState>(createProviderAction, () => undefined);
  const [adapter, setAdapter] = useState(adapters.find((option) => option.sharing)?.adapter ?? adapters[0]?.adapter ?? "");
  const [organizationId, setOrganizationId] = useState("");
  const created = state.status === "created" ? state : null;
  const selected = adapters.find((option) => option.adapter === adapter) ?? adapters[0];

  const error = state.status === "error" ? state : null;

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={created ? `${created.name} added` : "Add provider"}
      description={created ? undefined : "Credentials are checked live before they're stored."}
    >
      {created ? (
        <div className="flex flex-col gap-4">
          <VerificationResult verified={created.verified} adapterLabel={selected?.adapterLabel ?? "The adapter"} />
          {created.configured ? null : (
            <Callout tone="info" title="Setup is running">
              Status delivery from AWS finishes once SNS confirms the subscription.
            </Callout>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="md" onClick={onClose}>
              Close
            </Button>
            <Link href={`/admin/settings/providers/${created.id}`} className={buttonVariants({ size: "md" })}>
              Open provider
            </Link>
          </div>
        </div>
      ) : (
        <form onSubmit={keepValues(formAction)} className="flex flex-col gap-5">
          <input type="hidden" name="adapter" value={adapter} />
          <Field id="provider-adapter" label="Adapter" hint={selected?.sharing ? "Serves every organization assigned to it, each isolated at the provider." : "Serves one organization."}>
            <Select
              id="provider-adapter"
              items={adapters.map((option) => ({ value: option.adapter, label: option.adapterLabel }))}
              value={adapter}
              onValueChange={setAdapter}
              size="md"
              shape="compact"
            />
          </Field>

          {selected && !selected.sharing ? (
            <Field id="provider-organization" label="Organization" error={error?.field === "organizationId" ? error.message : undefined}>
              <input type="hidden" name="organizationId" value={organizationId} />
              <Select
                id="provider-organization"
                items={organizations.map((org) => ({ value: org.id, label: org.name }))}
                value={organizationId}
                onValueChange={setOrganizationId}
                placeholder="Choose an organization"
                size="md"
                shape="compact"
              />
            </Field>
          ) : null}

          <Field id="provider-name" label="Name" hint="Organizations see this name." error={error?.field === "name" ? error.message : undefined}>
            <input id="provider-name" name="name" required maxLength={200} autoComplete="off" className={inputClass} />
          </Field>

          <CredentialFields key={adapter} specs={selected?.credentialFieldSpecs ?? []} idPrefix="provider" />

          {error && error.field !== "name" && error.field !== "organizationId" ? (
            <p className="type-body-sm text-danger">{error.message}</p>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="secondary" size="md" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="md" loading={pending}>
              Add provider
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
