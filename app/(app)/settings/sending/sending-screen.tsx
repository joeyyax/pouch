import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { KeyValueList } from "@/components/ui/key-value-list";
import { describeBlocklistStatus } from "@/lib/blocklists/copy";
import type { BlocklistStatus } from "@/lib/blocklists/status";
import type { QueueSummary, SendingProviderView } from "@/lib/dashboard/views/service";
import type { ObservationSetting } from "@/lib/observations/_mutes";
import { SectionHeader } from "../../_ui/section-header";
import { Time } from "../../_ui/time";
import { DmarcReportsSection, type DmarcReportsSetting } from "./dmarc-reports-section";
import { ObservationsSection } from "./observations-section";
import { SendingSection } from "./sending-section";

export function SendingScreen({
  provider,
  manageHref,
  queue,
  blocklists,
  zone,
  observations,
  dmarcReports,
  canManage,
}: {
  provider: SendingProviderView | null;
  manageHref: string | null;
  queue: QueueSummary;
  blocklists: BlocklistStatus;
  /** The viewer's zone, for dates. */
  zone: string;
  /** Null while the observations feature is off. */
  observations: ObservationSetting[] | null;
  /** Null while the DMARC reports feature is off. */
  dmarcReports: DmarcReportsSetting | null;
  /** Whether the viewer may change observations and DMARC reports. */
  canManage: boolean;
}) {
  const blocklist = describeBlocklistStatus(blocklists);

  return (
    <div className="flex flex-col gap-6">
      <SendingSection provider={provider} manageHref={manageHref} zone={zone} />

      <section className="flex flex-col gap-3">
        <SectionHeader
          title="Blocklist checks"
          description="Checks sending domains and the domains their mail links to against Spamhaus."
        />
        <Card className="flex flex-col gap-2 p-5 sm:flex-row sm:items-center sm:gap-3">
          <span>
            <Chip tone={blocklist.tone}>{blocklist.label}</Chip>
          </span>
          <p className="type-body-sm text-foreground-soft">
            {blocklist.text}
            {blocklist.code ? (
              <>
                {" "}
                <code className="font-mono text-sm">{blocklist.code}</code>.
              </>
            ) : null}
          </p>
        </Card>
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeader title="Queue" description="Messages waiting to send." />
        <Card className="p-5">
          <KeyValueList
            items={[
              {
                label: "Queue depth",
                value: (
                  <span className={queue.depth === 0 ? "text-muted-foreground" : undefined}>
                    {queue.depth} {queue.depth === 1 ? "message" : "messages"}
                  </span>
                ),
                mono: false,
              },
              {
                label: "Oldest queued",
                value: queue.oldestQueuedAt ? (
                  <Time date={queue.oldestQueuedAt} />
                ) : (
                  <span className="text-muted-foreground">nothing waiting</span>
                ),
                mono: false,
              },
            ]}
          />
        </Card>
      </section>

      {observations ? <ObservationsSection observations={observations} canManage={canManage} /> : null}

      {dmarcReports ? <DmarcReportsSection setting={dmarcReports} canManage={canManage} /> : null}
    </div>
  );
}
