import { Card } from "@/components/ui/card";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { TextLink } from "@/components/ui/text-link";
import type { SendingProviderView } from "@/lib/dashboard/views/service";
import { untilLabel } from "@/lib/format/time";
import { SectionHeader } from "../../_ui/section-header";
import { UnassignedAlert } from "../../_ui/unassigned-alert";

const STATUS: Record<SendingProviderView["status"], { tone: ChipTone; label: string }> = {
  ready: { tone: "good", label: "ready" },
  setting_up: { tone: "warn", label: "setting up" },
  paused: { tone: "warn", label: "paused" },
  unavailable: { tone: "issue", label: "unavailable" },
};

function problemOf(provider: SendingProviderView, zone: string): string | null {
  switch (provider.status) {
    case "ready":
      return null;
    case "setting_up":
      return "An admin is finishing setup.";
    case "paused":
      return provider.backoffUntil
        ? `The provider asked for a pause. Sending resumes ${untilLabel(provider.backoffUntil, zone)}.`
        : "The provider paused sending. Queued mail sends when it lifts.";
    case "unavailable":
      return "The last check on this provider failed. An admin needs to fix it.";
  }
}

/** The organization's assigned provider, read-only. `manageHref` is set for admins only. */
export function SendingSection({
  provider,
  manageHref,
  zone,
}: {
  provider: SendingProviderView | null;
  manageHref: string | null;
  zone: string;
}) {
  const status = provider ? STATUS[provider.status] : null;
  const problem = provider ? problemOf(provider, zone) : null;

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader title="Sending" description="The provider this organization's domains send through." />

      {provider && status ? (
        <Card className="flex flex-col gap-2 p-5" data-sending-provider>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 break-words text-15 font-medium text-foreground">{provider.name}</span>
            <span className="text-sm text-muted-foreground">{provider.adapterLabel}</span>
            <Chip tone={status.tone}>{status.label}</Chip>
            {manageHref ? (
              <TextLink href={manageHref} className="ml-auto text-sm">
                Manage
              </TextLink>
            ) : null}
          </div>
          {problem ? <p className="type-body-sm text-foreground-soft">{problem}</p> : null}
        </Card>
      ) : (
        <UnassignedAlert />
      )}
    </section>
  );
}
