import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "@/components/ui/table";
import { passShare, type DmarcOrigin, type DmarcPanel, type PassCounts } from "@/lib/dmarc/read";
import { formatNumber } from "@/lib/format/number";
import { SectionHeader } from "../../../_ui/section-header";
import { StandingChip } from "../../../_ui/status";
import { Time } from "../../../_ui/time";
import { DmarcRecordToPublish } from "../../dmarc-card";

const ORIGIN_LABEL: Record<DmarcOrigin, string> = {
  provider: "This domain's provider",
  other: "Other senders you authorize",
  forwarded: "Forwarded",
  unauthenticated: "Not authenticated",
};

const ORIGIN_HELP: Record<DmarcOrigin, string> = {
  provider: "Signed with the provider's DKIM key or sent from its envelope host.",
  other: "Passed DMARC without the provider, so your DNS authorizes them.",
  forwarded: "Carried a DKIM signature for the domain that broke on the way, as forwarding and mailing lists do.",
  unauthenticated: "Failed DMARC and carried nothing of this domain's. Someone else sending as it.",
};

const ORDER: DmarcOrigin[] = ["provider", "other", "forwarded", "unauthenticated"];

function Rates({ counts }: { counts: PassCounts }) {
  return (
    <>
      <TableCell className="text-right font-mono text-sm tabular-nums">{formatNumber(counts.messages)}</TableCell>
      <TableCell className="text-right font-mono text-sm tabular-nums">{passShare(counts.spf, counts.messages)}</TableCell>
      <TableCell className="text-right font-mono text-sm tabular-nums">{passShare(counts.dkim, counts.messages)}</TableCell>
      <TableCell className="text-right font-mono text-sm tabular-nums">{passShare(counts.dmarc, counts.messages)}</TableCell>
    </>
  );
}

const RATE_COLUMNS = ["Messages", "SPF aligned", "DKIM aligned", "DMARC pass"] as const;

/** Spans the table, so the sender rows and the address rows share one set of columns. */
function GroupRow({ label }: { label: string }) {
  return (
    <tr className="border-b border-border bg-muted/40">
      <th scope="colgroup" colSpan={5} className="type-label px-4 py-2 text-left text-muted-foreground">
        {label}
      </th>
    </tr>
  );
}

/** One line while nothing needs a look; the sources and their rates one click away. */
export function DmarcReportsCard({ panel }: { panel: DmarcPanel }) {
  const { summary, receiving, verdict, recommendation } = panel;
  const total = ORDER.reduce((sum, origin) => sum + summary.byOrigin[origin].messages, 0);
  const own = summary.byOrigin.provider;
  const spoofed = summary.byOrigin.unauthenticated;
  const spoofedSources = summary.sources.filter((source) => source.origin === "unauthenticated");

  return (
    <Card className="flex flex-col gap-3 p-5">
      <SectionHeader
        title="DMARC reports"
        meta={
          summary.reports === 0
            ? undefined
            : `${formatNumber(summary.reports)} ${summary.reports === 1 ? "report" : "reports"} from ${formatNumber(summary.reporters)} mailbox ${summary.reporters === 1 ? "provider" : "providers"} over ${summary.days} days.`
        }
      />
      {summary.reports === 0 ? (
        <p className="type-body-sm text-muted-foreground">
          No reports yet. Once the domain&apos;s DMARC record carries its report address, mailbox providers send about one a day.
        </p>
      ) : (
        <>
          <p className="type-body flex flex-wrap items-center gap-2 text-foreground">
            <StandingChip standing={verdict.standing} />
            <span>{verdict.headline}</span>
          </p>
          <p className="type-body-sm text-foreground-soft">
            Over {summary.days} days, {passShare(own.dmarc, own.messages)} of {formatNumber(own.messages)} messages through the provider passed DMARC.
            {spoofed.messages > 0
              ? ` ${formatNumber(spoofed.messages)} more from ${formatNumber(spoofedSources.length)} ${spoofedSources.length === 1 ? "source" : "sources"} failed it and weren't yours.`
              : null}
          </p>
          {summary.lastReportAt ? (
            <p className="type-body-sm text-muted-foreground">
              Latest report covers to <Time date={summary.lastReportAt} />.
              {receiving ? null : " New reports aren’t arriving: the report host isn’t receiving right now."}
            </p>
          ) : null}
          {recommendation ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <p className="type-body-sm font-semibold text-foreground">Ready for p=quarantine</p>
              <p className="type-body-sm text-foreground-soft">
                Reports have read healthy for {formatNumber(recommendation.days)} days in a row, so receivers can start filtering mail that fails DMARC.
              </p>
              <DmarcRecordToPublish name={recommendation.name} value={recommendation.value} optional={false} note="Replace the published record with this one. Only p changes." />
            </div>
          ) : null}
          <details className="rounded-lg border border-border">
            <summary className="cursor-pointer px-3 py-2 type-body-sm font-semibold text-foreground">
              Sources <span className="font-normal tabular-nums text-muted-foreground">{formatNumber(total)} messages</span>
            </summary>
            <div className="border-t border-border">
              <Table label="DMARC results by sender and source address" className="min-w-[36rem]">
                <TableHead>
                  <tr>
                    <TableHeaderCell className="min-w-44">Source</TableHeaderCell>
                    {RATE_COLUMNS.map((column) => (
                      <TableHeaderCell key={column} className="w-24 whitespace-nowrap text-right">
                        {column}
                      </TableHeaderCell>
                    ))}
                  </tr>
                </TableHead>
                <TableBody>
                  <GroupRow label="By sender" />
                  {ORDER.filter((origin) => summary.byOrigin[origin].messages > 0).map((origin) => (
                    <TableRow key={origin}>
                      <TableCell>
                        <span className="type-body-sm block text-foreground">{ORIGIN_LABEL[origin]}</span>
                        <span className="type-body-sm hidden text-muted-foreground sm:block">{ORIGIN_HELP[origin]}</span>
                      </TableCell>
                      <Rates counts={summary.byOrigin[origin]} />
                    </TableRow>
                  ))}
                  <GroupRow label="By source address" />
                  {summary.sources.map((source) => (
                    <TableRow key={`${source.ip}:${source.origin}`}>
                      <TableCell>
                        <span className="block whitespace-nowrap font-mono text-sm text-foreground">{source.ip}</span>
                        <span className="type-body-sm block text-muted-foreground">{ORIGIN_LABEL[source.origin]}</span>
                      </TableCell>
                      <Rates counts={source} />
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </details>
        </>
      )}
    </Card>
  );
}
