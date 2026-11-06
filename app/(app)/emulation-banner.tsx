"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { untilLabel } from "@/lib/format/time";
import { useAction } from "./_ui/use-action";
import { useTimeZone } from "./_ui/time-zone";
import { stopEmulationAction } from "./emulation-actions";

/**
 * Present on every screen for as long as emulation lasts, with the exit control in it. Sticky
 * rather than scrolled away: the way out has to be reachable from wherever the admin is.
 */
export function EmulationBanner({ organizationName, expiresAt }: { organizationName: string; expiresAt: Date }) {
  const router = useRouter();
  // Leaving redirects server-side; only a failure comes back here, and useAction toasts it.
  const { formAction, pending } = useAction(stopEmulationAction);
  const zone = useTimeZone();
  const [ends, setEnds] = useState(() => untilLabel(expiresAt, zone));

  useEffect(() => {
    const tick = () => {
      setEnds(untilLabel(expiresAt, zone));
      if (expiresAt.getTime() <= Date.now()) router.refresh();
    };
    tick();
    const timer = setInterval(tick, 15_000);
    return () => clearInterval(timer);
  }, [expiresAt, router, zone]);

  return (
    <div className="sticky top-0 z-30 pb-4">
      <Alert
        tone="warn"
        title={`You're emulating ${organizationName}`}
        action={
          <form action={formAction}>
            <Button type="submit" size="sm" variant="secondary" loading={pending}>
              Exit emulation
            </Button>
          </form>
        }
      >
        <p suppressHydrationWarning>
          You&apos;re in someone else&apos;s organization. Every change you make happens to their data and is recorded
          as yours. Emulation ends {ends}.
        </p>
      </Alert>
    </div>
  );
}
