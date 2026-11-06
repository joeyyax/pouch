"use client";

import { TextLink } from "@/components/ui/text-link";
import { zoneLabel } from "@/lib/format/time";
import { zoneName } from "@/lib/time-zone";
import { Term } from "./term";
import { useTimeZone } from "./time-zone";

/** The zone's short name, once per list, explaining where times come from and where to change it. */
export function ZoneNote() {
  const zone = useTimeZone();
  return (
    <Term
      definition={
        <>
          Times are in {zoneName(zone)}. Change it in <TextLink href="/user/settings">your settings</TextLink>.
        </>
      }
    >
      {zoneLabel(new Date(), zone)}
    </Term>
  );
}
