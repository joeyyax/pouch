import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrganization } from "@/lib/dashboard/session";
import { readInboundForOrg, listInboundDomainOptions } from "@/lib/dashboard/inbound";
import { PageHeader } from "../../_ui/page-header";
import { Time } from "../../_ui/time";
import { StatusChip } from "../../_ui/status";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { byteLabel, untilLabel, zonedTime } from "@/lib/format/time";
import type { InboundVerdicts } from "@/lib/providers/adapters/types";
import { DELIVERY_LABEL, DELIVERY_TONE, deliveryDetail } from "@/lib/dashboard/views/inbound";
import { RedeliverButton } from "../redeliver-button";

export const dynamic = "force-dynamic";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

const CHECK_LABEL: Record<keyof InboundVerdicts, string> = { spf: "SPF", dkim: "DKIM", dmarc: "DMARC", spam: "spam", virus: "virus" };
const CHECK_ORDER: (keyof InboundVerdicts)[] = ["spf", "dkim", "dmarc", "spam", "virus"];

/** All passing collapses to one line. Anything else names each check and flags the ones that didn't pass. */
function Checks({ verdicts }: { verdicts: InboundVerdicts }) {
  const checks = CHECK_ORDER.flatMap((key) => (verdicts[key] ? [{ key, verdict: verdicts[key].toLowerCase() }] : []));
  if (checks.every((check) => check.verdict === "pass")) {
    return <>All passed: {checks.map((check) => CHECK_LABEL[check.key]).join(", ")}</>;
  }
  return (
    <>
      {checks.map((check, index) => (
        <span key={check.key}>
          {index > 0 ? ", " : null}
          <span className={check.verdict === "pass" ? undefined : "font-medium text-warning"}>
            {CHECK_LABEL[check.key]} {check.verdict}
          </span>
        </span>
      ))}
    </>
  );
}

export default async function InboundDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { organizationId, timeZone } = await requireOrganization();
  const { id } = await params;
  const [message, domainOptions] = await Promise.all([
    readInboundForOrg(organizationId, id),
    listInboundDomainOptions(organizationId),
  ]);
  if (!message) notFound();

  const domainName = domainOptions.find((option) => option.id === message.domain_id)?.name ?? message.domain_id;

  return (
    <div>
      <PageHeader
        eyebrow="Inbound"
        title={message.subject || "(no subject)"}
        status={
          message.delivery ? (
            <Chip tone={DELIVERY_TONE[message.delivery.status]} title={deliveryDetail(message.delivery)}>
              Webhook {DELIVERY_LABEL[message.delivery.status]}
            </Chip>
          ) : undefined
        }
        meta={
          <>
            Received <Time date={new Date(message.received_at)} /> on {domainName}.
          </>
        }
        actions={<RedeliverButton id={message.id} />}
      />

      <Card className="mb-4 p-5 text-sm">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
          <Row label="From">{message.from}</Row>
          <Row label="To">{message.to.join(", ")}</Row>
          <Row label="Expires">
            <time dateTime={message.expires_at} title={zonedTime(new Date(message.expires_at), timeZone)}>
              {untilLabel(new Date(message.expires_at), timeZone)}
            </time>
          </Row>
          {message.verdicts && CHECK_ORDER.some((key) => message.verdicts?.[key]) ? (
            <Row label="Checks">
              <Checks verdicts={message.verdicts} />
            </Row>
          ) : null}
          {message.message_id ? (
            <Row label="Message-Id">
              <code className="font-mono text-xs">{message.message_id}</code>
            </Row>
          ) : null}
          {message.in_reply_to ? (
            <Row label="In-Reply-To">
              <code className="font-mono text-xs">{message.in_reply_to}</code>
              {!message.repliedTo ? <span className="text-muted-foreground"> · no matching sent message</span> : null}
            </Row>
          ) : null}
        </dl>
        {message.raw_download_url ? (
          <a href={message.raw_download_url} className="mt-4 inline-block font-medium underline underline-offset-4 hover:no-underline">
            Download the original message
          </a>
        ) : null}
      </Card>

      {message.repliedTo ? (
        <Card className="mb-4 p-4 text-sm">
          <p className="mb-2 font-semibold">Reply to</p>
          <div className="flex items-center gap-2">
            <StatusChip status={message.repliedTo.status} />
            <Link href={`/messages/${message.repliedTo.id}`} className="font-medium underline underline-offset-4 hover:no-underline">
              {message.repliedTo.subject || "(no subject)"}
            </Link>
          </div>
          <div className="mt-1 text-foreground-soft">
            Sent <Time date={message.repliedTo.createdAt} />
          </div>
        </Card>
      ) : null}

      {message.attachments.length > 0 ? (
        <Card className="mb-4 p-4 text-sm">
          <p className="mb-2 font-semibold">Attachments</p>
          <ul className="space-y-1">
            {message.attachments.map((attachment, index) => (
              <li key={index}>
                {attachment.download_url ? (
                  <a href={attachment.download_url} className="font-medium underline underline-offset-4 hover:no-underline">
                    {attachment.filename}
                  </a>
                ) : (
                  attachment.filename
                )}{" "}
                <span className="text-muted-foreground">
                  · {attachment.content_type} · {byteLabel(attachment.size)}
                </span>
                {attachment.quarantined ? <span className="text-warning"> · quarantined, failed the virus scan</span> : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {message.html ? (
        <Card className="mb-4 p-4">
          <p className="mb-2 text-sm font-semibold">HTML body</p>
          {/* Inbound mail from outside the organization: rendered inline for review, not trusted as
              same-origin content — no script execution risk here since this isn't set on a live DOM
              node via dangerouslySetInnerHTML in a page that also runs the app's own scripts. */}
          <iframe title="Message body" sandbox="" srcDoc={message.html} className="h-96 w-full rounded-md border" />
        </Card>
      ) : message.text ? (
        <Card className="mb-4 whitespace-pre-wrap p-4 text-sm">{message.text}</Card>
      ) : null}
    </div>
  );
}
