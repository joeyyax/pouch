"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Icon } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import type { ConversionStage } from "@/lib/providers/convert";
import { idle } from "@/lib/dashboard/action-state";
import type { ConversionView } from "@/lib/dashboard/admin-providers";
import { cn } from "@/lib/utils";
import { convertProviderAction, type ConvertState } from "../actions";

const STAGE_LABEL: Record<ConversionStage, string> = {
  parent: "Find or create the shared provider",
  parent_setup: "Set up status delivery from AWS",
  tenant: "Create its own space at the provider",
  associate: "Move the configuration set and domains over",
  tag: "Tag each domain as the organization's",
  suppression: "Copy the suppression list over",
  flip: "Switch sends over",
};

type StageState = "done" | "todo" | "stopped";

function stageStates(conversion: ConversionView, state: ConvertState): Map<ConversionStage, StageState> {
  const order = conversion.stages.map((entry) => entry.stage);
  const states = new Map<ConversionStage, StageState>(conversion.stages.map((entry) => [entry.stage, entry.done ? "done" : "todo"]));
  if (state.status === "converted") for (const stage of order) states.set(stage, "done");
  if (state.status === "stopped") {
    const reached = state.reached ? order.indexOf(state.reached) : -1;
    order.forEach((stage, index) => {
      if (index <= reached) states.set(stage, "done");
    });
    states.set(state.stage, "stopped");
  }
  return states;
}

export function ConvertDialog({
  provider,
  conversion,
  onClose,
}: {
  provider: { id: string; name: string; organizationName: string };
  conversion: ConversionView;
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState<ConvertState, FormData>(convertProviderAction, idle);
  const states = stageStates(conversion, state);
  const parent = conversion.parentExists ? conversion.parentName : `a new shared provider, ${conversion.parentName}`;

  return (
    <Modal
      open
      onOpenChange={(open) => !open && !pending && onClose()}
      title={`Move ${provider.name} onto a shared provider?`}
      description={`After this, ${provider.organizationName} sends through ${parent}, on the same AWS account and isolated from every other organization. The provider keeps its id, webhook URL, configuration set and DNS records.`}
    >
      <div className="flex flex-col gap-4">
        <ul className="type-body-sm flex list-disc flex-col gap-1 pl-5 text-foreground-soft">
          <li>Sending doesn&apos;t stop. Sends after the last step go out through its own space.</li>
          <li>The organization gets its own suppression list, seeded from the provider&apos;s, and SES can pause it on its own.</li>
          <li>
            {conversion.identities.length > 0
              ? `Moves ${conversion.identities.length} ${conversion.identities.length === 1 ? "domain" : "domains"}: ${conversion.identities.join(", ")}.`
              : "No domains to move."}
          </li>
          <li>The credentials&apos; permissions are checked first. A missing one stops the run before anything changes.</li>
        </ul>

        <ol className="flex flex-col gap-1.5" aria-label="Steps">
          {conversion.stages.map(({ stage }) => {
            const current = states.get(stage) ?? "todo";
            const running = pending && current === "todo";
            return (
              <li key={stage} className="type-body-sm flex items-center gap-2">
                <Icon
                  name={current === "done" ? "check" : current === "stopped" ? "danger" : "dash"}
                  className={cn(
                    "size-4 shrink-0",
                    current === "done" && "text-success-ink",
                    current === "stopped" && "text-danger",
                    current === "todo" && "text-muted-foreground",
                    running && "animate-pulse",
                  )}
                />
                <span className={cn(current === "done" ? "text-muted-foreground" : "text-foreground")}>{STAGE_LABEL[stage]}</span>
              </li>
            );
          })}
        </ol>

        {state.status === "stopped" ? (
          <Callout tone="danger" title={`Stopped at: ${STAGE_LABEL[state.stage]}`}>
            {state.message} Nothing after this step ran. Convert again to resume here.
          </Callout>
        ) : null}
        {state.status === "error" ? (
          <Callout tone="danger" title="Didn't start">
            {state.message}
          </Callout>
        ) : null}
        {state.status === "converted" ? (
          <Callout tone="success" title="Converted">
            {provider.name} sends through {conversion.parentName}, isolated.
            {state.suppressionsCopied > 0 ? ` Copied ${state.suppressionsCopied} suppressed addresses.` : ""}
          </Callout>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          {state.status === "converted" ? (
            <Button size="md" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button type="button" variant="secondary" size="md" disabled={pending} onClick={onClose}>
                Cancel
              </Button>
              <form action={formAction}>
                <input type="hidden" name="id" value={provider.id} />
                <Button type="submit" size="md" loading={pending}>
                  {state.status === "stopped" ? "Resume" : "Convert"}
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
