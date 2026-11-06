"use client";

import { startTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import type { ObservationSetting } from "@/lib/observations/_mutes";
import { RoleGate } from "../../_ui/role-gate";
import { SectionHeader } from "../../_ui/section-header";
import { useAction } from "../../_ui/use-action";
import { setObservationOnAction, unmuteObservationAction } from "../actions";

const OWNER_REASON = "You need to be an owner to change observations.";

function ObservationRow({ observation, canManage }: { observation: ObservationSetting; canManage: boolean }) {
  const toggle = useAction(setObservationOnAction);
  const unmute = useAction(unmuteObservationAction);

  function setOn(checked: boolean) {
    const form = new FormData();
    form.set("observation", observation.key);
    form.set("on", String(checked));
    startTransition(() => toggle.formAction(form));
  }

  return (
    <li className="flex flex-col gap-3 p-5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{observation.title}</h3>
          <p className="type-body-sm mt-1 text-muted-foreground">{observation.description}</p>
        </div>
        <RoleGate allowed={canManage} reason={OWNER_REASON}>
          <Switch checked={observation.on} onCheckedChange={setOn} disabled={toggle.pending} aria-label={observation.title} />
        </RoleGate>
      </div>
      {observation.mutes.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {observation.mutes.map((mute) => (
            <li key={mute.id} className="flex items-center justify-between gap-4 text-sm">
              <span className="min-w-0 text-foreground-soft">
                Muted for {mute.kind === "tag" ? "the " : "key "}
                <span className="font-medium text-foreground">{mute.label}</span>
                {mute.kind === "tag" ? " tag" : null}
              </span>
              <form action={unmute.formAction}>
                <input type="hidden" name="muteId" value={mute.id} />
                <RoleGate allowed={canManage} reason={OWNER_REASON}>
                  <Button type="submit" variant="secondary" size="sm" loading={unmute.pending}>
                    Unmute
                  </Button>
                </RoleGate>
              </form>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Every observation, on or off for the organization, with its tag and key mutes. */
export function ObservationsSection({ observations, canManage }: { observations: ObservationSetting[]; canManage: boolean }) {
  if (observations.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        title="Observations"
        description="Patterns in what each send records, never its content. Turning one off or muting it hides it from the overview and the digest."
      />
      <Card className="p-0">
        <ul className="divide-y divide-border">
          {observations.map((observation) => (
            <ObservationRow key={observation.key} observation={observation} canManage={canManage} />
          ))}
        </ul>
      </Card>
    </section>
  );
}
