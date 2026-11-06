"use client";

import { keepValues } from "./_ui/keep-values";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { fieldClasses, Field } from "@/components/ui/field";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { Icon } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import type { ActionState } from "@/lib/dashboard/action-state";
import { useAction } from "./_ui/use-action";
import type { OrgRole } from "@/lib/auth/permissions";
import { slugify } from "@/lib/slug";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { createOrganizationAction } from "./create-organization-action";
import { switchOrganizationAction } from "./switch-organization-action";

export interface SwitcherOrganization {
  id: string;
  name: string;
  slug: string;
  role: OrgRole;
}

const ROLE_LABEL: Record<OrgRole, string> = {
  owner: "Owner",
  member: "Member",
};

export function roleLabel(role: OrgRole): string {
  return ROLE_LABEL[role];
}

/**
 * The organizations a user is a member of, plus "Add organization" when they may create one — the reusable core of
 * switching. An organization an admin is only emulating is never in here: it isn't theirs, and
 * leaving it is the banner's job, not this list's.
 */
export function OrganizationList({
  current,
  organizations,
  canCreate,
  onSwitched,
}: {
  /** Null while an admin is emulating, or when they belong to nothing yet — nothing is checked. */
  current: SwitcherOrganization | null;
  organizations: SwitcherOrganization[];
  /** Offers "Add organization". */
  canCreate: boolean;
  /** Called after a successful switch or a successful create — the caller's cue to close
   * whatever it's showing this list inside. */
  onSwitched?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState(false);
  const [creating, setCreating] = useState(false);
  // Bumped each time the dialog opens so it remounts with a blank form — simpler than
  // resetting its internal state from an effect once creation succeeds.
  const [dialogKey, setDialogKey] = useState(0);

  function switchTo(id: string) {
    if (id === current?.id) return;
    setError(false);
    startTransition(async () => {
      const result = await switchOrganizationAction(id);
      if (!result.ok) {
        setError(true);
        return;
      }
      router.refresh();
      onSwitched?.();
    });
  }

  return (
    <div className="flex flex-col gap-0.5">
      {organizations.map((org) => {
        const isCurrent = org.id === current?.id;
        return (
          <button
            key={org.id}
            type="button"
            disabled={pending}
            onClick={() => switchTo(org.id)}
            className={cn(
              "squircle flex items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors pointer-coarse:min-h-11",
              FOCUS_RING,
              isCurrent ? "bg-accent text-accent-foreground" : "text-tertiary hover:bg-muted hover:text-foreground",
              pending && "opacity-60",
            )}
          >
            <Icon name="globe" className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{org.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{roleLabel(org.role)}</span>
            {isCurrent && <Icon name="check" className="size-4 shrink-0" />}
          </button>
        );
      })}
      {error && <span className="px-3 text-xs text-danger">Couldn&apos;t switch — try again.</span>}
      {canCreate ? (
        <>
          <button
            type="button"
            onClick={() => {
              setDialogKey((key) => key + 1);
              setCreating(true);
            }}
            className={cn(
              "squircle flex items-center gap-1.5 rounded-xl px-3 py-2 text-left text-sm font-medium text-tertiary transition-colors hover:bg-muted hover:text-foreground pointer-coarse:min-h-11",
              FOCUS_RING,
            )}
          >
            <Icon name="plus" strokeWidth={2.5} className="size-4 shrink-0" />
            Add organization
          </button>
          <CreateOrganizationDialog
            key={dialogKey}
            open={creating}
            onOpenChange={setCreating}
            onCreated={() => {
              router.refresh();
              onSwitched?.();
            }}
          />
        </>
      ) : null}
    </div>
  );
}

function CreateOrganizationDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const { state, formAction, pending } = useAction<ActionState>(createOrganizationAction, (result) => {
    if (result.status === "ok") {
      toast({ title: result.message, variant: "success" });
      onOpenChange(false);
      onCreated();
    }
    if (result.status === "error" && !result.field) toast({ title: result.message, variant: "error" });
  });
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Add organization"
      description="Creates a new organization and switches you into it."
      footer={
        <>
          <Button type="button" variant="secondary" size="md" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="create-organization" size="md" loading={pending}>
            Create organization
          </Button>
        </>
      }
    >
      <form id="create-organization" onSubmit={keepValues(formAction)} className="flex flex-col gap-4">
        <Field
          id="organization-name"
          label="Name"
          error={state.status === "error" && state.field === "name" ? state.message : undefined}
        >
          <input
            id="organization-name"
            name="name"
            type="text"
            required
            value={name}
            onChange={(event) => {
              const next = event.target.value;
              setName(next);
              if (!slugEdited) setSlug(slugify(next));
            }}
            className={`${fieldClasses({ shape: "compact", size: "md" })} w-full`}
          />
        </Field>
        <Field
          id="organization-slug"
          label="Slug"
          hint="Lowercase letters, numbers and hyphens."
          error={state.status === "error" && state.field === "slug" ? state.message : undefined}
        >
          <input
            id="organization-slug"
            name="slug"
            type="text"
            value={slug}
            onChange={(event) => {
              setSlugEdited(true);
              setSlug(event.target.value);
            }}
            className={`${fieldClasses({ shape: "compact", size: "md" })} w-full`}
          />
        </Field>
      </form>
    </Modal>
  );
}
