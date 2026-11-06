"use client";

import { startTransition, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useOpenerFocus } from "@/hooks/use-opener-focus";
import type { OrganizationContents } from "@/lib/organizations/delete";
import { RoleGate } from "../../_ui/role-gate";
import { useAction } from "../../_ui/use-action";
import { deleteOrganizationAction } from "../actions";
import { formatNumber } from "@/lib/format/number";

const OWNER_ONLY = "You need to be an owner to delete this organization.";

export function DeleteOrganizationSection({
  organization,
  contents,
  blocked,
  lastOrganization,
  canManage,
}: {
  organization: { id: string; name: string };
  contents: OrganizationContents;
  /** Why the delete is refused right now, in the same words the API returns. */
  blocked: string | null;
  /** True when it's the only organization the person belongs to. */
  lastOrganization: boolean;
  canManage: boolean;
}) {
  const remove = useAction(deleteOrganizationAction);
  const [asking, setAsking] = useState(false);
  const opener = useOpenerFocus();

  return (
    <>
      <Card className="flex flex-col gap-4 p-5">
        <p className="type-body-sm text-foreground-soft">
          {blocked ?? `${count(contents.domains, "domain")} and ${count(contents.messages, "message")} go with it.`}
        </p>
        <div>
          <RoleGate allowed={canManage} reason={OWNER_ONLY}>
            <Button
              type="button"
              variant="danger"
              size="md"
              disabled={blocked !== null}
              onClick={(event) => {
                opener.remember(event);
                setAsking(true);
              }}
            >
              Delete organization
            </Button>
          </RoleGate>
        </div>
      </Card>

      <ConfirmDialog
        open={asking}
        onOpenChange={(open) => !open && setAsking(false)}
        onCloseAutoFocus={opener.restore}
        title={`Delete ${organization.name}?`}
        consequence={consequenceOf(contents)}
        confirmLabel="Delete organization"
        tone="destructive"
        loading={remove.pending}
        onConfirm={() => {
          const form = new FormData();
          form.set("id", organization.id);
          startTransition(() => remove.formAction(form));
          setAsking(false);
        }}
      >
        <p className="type-body-sm text-muted-foreground">
          Accounts and their other organizations stay. The provider and the organizations sharing it are untouched.
          {lastOrganization ? " It's your only organization, so you'll create a new one next." : ""}
        </p>
      </ConfirmDialog>
    </>
  );
}

function count(n: number, noun: string): string {
  return `${formatNumber(n)} ${n === 1 ? noun : `${noun}s`}`;
}

/** Names what goes, exactly. The domain sentence is dropped when there are none to name. */
function consequenceOf(contents: OrganizationContents): string {
  const rest = `${count(contents.messages, "message")}, their events, every key, list, suppression and membership go with it.`;
  if (contents.domains === 0) return `It has no domains. ${rest}`;
  return `Its ${count(contents.domains, "domain")} come off the provider and stop sending immediately. ${rest}`;
}
