"use client";

import { useState } from "react";
import { PopoverContent, PopoverRoot, PopoverTrigger } from "@/components/ui/popover";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import type { MuteOffer } from "@/lib/observations/_types";
import { cn } from "@/lib/utils";
import { RoleGate } from "../_ui/role-gate";
import { useAction } from "../_ui/use-action";
import { muteObservationAction, setObservationOnAction } from "../settings/actions";

const OPTION = cn("flex w-full rounded-lg px-3 py-2.5 text-left text-sm font-medium text-foreground transition-colors hover:bg-muted", FOCUS_RING);

/** Mutes an observation's condition by the tag or key behind it, or turns the observation off. */
export function MuteMenu({ offer, canManage }: { offer: MuteOffer; canManage: boolean }) {
  const [open, setOpen] = useState(false);
  const mute = useAction(muteObservationAction);
  const turnOff = useAction(setObservationOnAction);
  const pending = mute.pending || turnOff.pending;

  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <RoleGate allowed={canManage} reason="You need to be an owner to mute an observation.">
        <PopoverTrigger asChild>
          <button type="button" disabled={pending} className={cn("mr-4 inline-block whitespace-nowrap underline underline-offset-4 hover:no-underline", FOCUS_RING)}>
            Mute
          </button>
        </PopoverTrigger>
      </RoleGate>
      <PopoverContent label={`Mute ${offer.title.toLowerCase()}`} align="end" className="w-64 p-1.5">
        <ul className="flex flex-col">
          {offer.tags.map((tag) => (
            <li key={`tag:${tag}`}>
              <form action={mute.formAction} onSubmit={() => setOpen(false)}>
                <input type="hidden" name="observation" value={offer.observation} />
                <input type="hidden" name="tag" value={tag} />
                <button type="submit" className={OPTION}>
                  For the {tag} tag
                </button>
              </form>
            </li>
          ))}
          {offer.keys.map((key) => (
            <li key={`key:${key.id}`}>
              <form action={mute.formAction} onSubmit={() => setOpen(false)}>
                <input type="hidden" name="observation" value={offer.observation} />
                <input type="hidden" name="keyId" value={key.id} />
                <button type="submit" className={OPTION}>
                  For key {key.name}
                </button>
              </form>
            </li>
          ))}
          <li>
            <form action={turnOff.formAction} onSubmit={() => setOpen(false)}>
              <input type="hidden" name="observation" value={offer.observation} />
              <input type="hidden" name="on" value="false" />
              <button type="submit" className={OPTION}>
                Turn off {offer.title.toLowerCase()}
              </button>
            </form>
          </li>
        </ul>
      </PopoverContent>
    </PopoverRoot>
  );
}
