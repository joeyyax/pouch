"use client";

import { keepValues } from "../../../../_ui/keep-values";
import { Button } from "@/components/ui/button";
import { Field, fieldClasses } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import type { ActionState } from "@/lib/dashboard/action-state";
import { toast } from "@/lib/toast";
import { useAction } from "../../../../_ui/use-action";
import { renameProviderAction } from "../actions";

export function RenameProviderDialog({ provider, onClose }: { provider: { id: string; name: string; shared: boolean }; onClose: () => void }) {
  // The failure stays on the field below, so only the success is worth a toast.
  const { state, formAction, pending } = useAction<ActionState>(renameProviderAction, (result) => {
    if (result.status === "ok") {
      toast({ title: result.message, variant: "success" });
      onClose();
    }
  });

  const error = state.status === "error" ? state : null;

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Rename ${provider.name}`}
      description={provider.shared ? "Organizations already on it keep the name they were given." : undefined}
    >
      <form onSubmit={keepValues(formAction)} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={provider.id} />
        <Field id="rename-provider" label="Name" error={error?.message}>
          <input
            id="rename-provider"
            name="name"
            defaultValue={provider.name}
            required
            maxLength={200}
            autoFocus
            autoComplete="off"
            className={`${fieldClasses({ shape: "compact", size: "md" })} w-full`}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="md" loading={pending}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
