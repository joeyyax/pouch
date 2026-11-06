"use client";

import { Button } from "@/components/ui/button";
import { useAction } from "../_ui/use-action";
import { redeliverInboundAction } from "./actions";

export function RedeliverButton({ id }: { id: string }) {
  const { formAction, pending } = useAction(redeliverInboundAction);

  return (
    <form action={formAction}>
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {pending ? "Redelivering…" : "Redeliver"}
      </Button>
    </form>
  );
}
