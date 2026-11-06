"use client";

import { keepValues } from "../../../../_ui/keep-values";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import type { CredentialFieldSpec } from "@/lib/dashboard/views/service";
import { useAction } from "../../../../_ui/use-action";
import { rotateCredentialsAction, type CredentialWriteState } from "../actions";
import { CredentialFields } from "./credential-fields";
import { VerificationResult } from "./verification-result";

export function RotateCredentialsDialog({
  provider,
  onClose,
}: {
  provider: { id: string; name: string; adapterLabel: string; shared: boolean; organizationCount: number; credentialFieldSpecs: CredentialFieldSpec[] };
  onClose: () => void;
}) {
  // Errors show in the dialog, so nothing is toasted.
  const { state, formAction, pending } = useAction<CredentialWriteState>(rotateCredentialsAction, () => undefined);
  const rotated = state.status === "rotated" ? state : null;

  const error = state.status === "error" ? state : null;
  const scope =
    provider.shared && provider.organizationCount > 0
      ? ` All ${provider.organizationCount} ${provider.organizationCount === 1 ? "organization" : "organizations"} on it switch at once.`
      : "";

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={rotated ? "Credentials replaced" : `Rotate credentials for ${provider.name}`}
      description={rotated ? undefined : `Enter every field. A rejected check leaves the stored credentials as they are.${scope}`}
    >
      {rotated ? (
        <div className="flex flex-col gap-4">
          <VerificationResult verified={rotated.verified} adapterLabel={provider.adapterLabel} />
          <div className="flex justify-end">
            <Button size="md" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={keepValues(formAction)} className="flex flex-col gap-5">
          <input type="hidden" name="id" value={provider.id} />
          <CredentialFields specs={provider.credentialFieldSpecs} idPrefix="rotate" />
          {error ? <p className="type-body-sm text-danger">{error.message}</p> : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="secondary" size="md" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="md" loading={pending}>
              Check and replace
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
