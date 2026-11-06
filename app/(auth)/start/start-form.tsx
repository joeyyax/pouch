"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field, fieldClasses } from "@/components/ui/field";
import { FieldMessage } from "@/components/ui/field-message";
import { idle, type ActionState } from "@/lib/dashboard/action-state";
import { slugify } from "@/lib/slug";
import { createOrganizationAction } from "../../(app)/create-organization-action";

export function StartForm() {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(createOrganizationAction, idle);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (state.status === "ok") router.replace("/");
  }, [state, router]);

  const error = state.status === "error" ? state : null;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field id="organization-name" label="Name" error={error?.field === "name" ? error.message : undefined}>
        <input
          id="organization-name"
          name="name"
          type="text"
          required
          maxLength={100}
          autoComplete="organization"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            if (!slugEdited) setSlug(slugify(event.target.value));
          }}
          className={`${fieldClasses({ shape: "compact", size: "md" })} w-full`}
        />
      </Field>
      <Field
        id="organization-slug"
        label="Slug"
        hint="Lowercase letters, numbers and hyphens."
        error={error?.field === "slug" ? error.message : undefined}
      >
        <input
          id="organization-slug"
          name="slug"
          type="text"
          maxLength={100}
          value={slug}
          onChange={(event) => {
            setSlugEdited(true);
            setSlug(event.target.value);
          }}
          className={`${fieldClasses({ shape: "compact", size: "md" })} w-full font-mono`}
        />
      </Field>
      {error && !error.field ? <FieldMessage tone="error">{error.message}</FieldMessage> : null}
      <Button type="submit" size="md" loading={pending} className="mt-1 w-full justify-center">
        Create organization
      </Button>
    </form>
  );
}
