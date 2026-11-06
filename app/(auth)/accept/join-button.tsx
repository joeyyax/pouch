"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FieldMessage } from "@/components/ui/field-message";
import { idle, type ActionState } from "@/lib/dashboard/action-state";
import { joinOrganizationAction } from "./actions";

export function JoinButton({ token, organizationName }: { token: string; organizationName: string }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(joinOrganizationAction, idle);
  const router = useRouter();

  useEffect(() => {
    if (state.status === "ok") {
      router.replace("/");
      router.refresh();
    }
  }, [state, router]);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="token" value={token} />
      {state.status === "error" ? <FieldMessage tone="error">{state.message}</FieldMessage> : null}
      <Button type="submit" size="md" loading={pending} className="w-full justify-center">
        Join {organizationName}
      </Button>
    </form>
  );
}
