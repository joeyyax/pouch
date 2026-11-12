"use client";

import { startTransition, useRef, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { DomainDetailData, DomainStandingSummary } from "@/lib/dashboard/views/domains";
import { dayLabel } from "@/lib/format/time";
import { useOpenerFocus } from "@/hooks/use-opener-focus";
import { OverflowMenu } from "../_ui/overflow-menu";
import { PageHeader } from "../_ui/page-header";
import { RoleGate } from "../_ui/role-gate";
import { SegmentedLinks } from "../_ui/segmented-links";
import { DomainChip, StandingChip, standingNote } from "../_ui/status";
import { Time } from "../_ui/time";
import { useTimeZone } from "../_ui/time-zone";
import { useAction } from "../_ui/use-action";
import { deleteDomainAction, releaseStallAction, verifyDomainAction } from "./actions";
import { DOMAIN_SECTIONS, SECTION_LABEL, type DomainSection } from "./sections";

export function DomainDetail({
  domain,
  standing,
  canManage,
  section,
  children,
}: {
  domain: DomainDetailData;
  /** Null for a domain with nothing to say, such as one still pending. */
  standing: DomainStandingSummary | null;
  canManage: boolean;
  section: DomainSection;
  children: ReactNode;
}) {
  const zone = useTimeZone();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const verify = useAction(verifyDomainAction);
  const remove = useAction(deleteDomainAction);
  const release = useAction(releaseStallAction);

  const confirming = params.get("state") === "delete";

  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useOpenerFocus(heading);

  function setConfirming(next: boolean) {
    const query = new URLSearchParams(params);
    if (next) query.set("state", "delete");
    else query.delete("state");
    const suffix = query.toString();
    router.push(suffix ? `${pathname}?${suffix}` : pathname, { scroll: false });
  }

  const liveKeys = domain.liveScopedKeys ?? [];
  const consequence = [
    historyNote(domain.deleteContents),
    liveKeys.length > 0
      ? `Its ${liveKeys.length} ${liveKeys.length === 1 ? "key stops" : "keys stop"} sending immediately.`
      : "Sends from it fail at the API.",
  ]
    .filter(Boolean)
    .join(" ");

  const unverified = domain.status !== "verified";
  const reputationHref = `/domains/${domain.id}/reputation`;

  return (
    <>
      <PageHeader
        titleRef={heading}
        eyebrow="Domains"
        title={<span className="font-mono [overflow-wrap:anywhere]">{domain.name}</span>}
        copy={{ value: domain.name, label: "domain name" }}
        status={
          domain.status === "verified" && standing ? (
            <StandingChip
              standing={standing.standing}
              explain={
                <>
                  {standingNote(standing.standing, standing.lead ? `${standing.lead.title}.` : null)}{" "}
                  {section === "reputation" ? null : (
                    <Link href={reputationHref} className="whitespace-nowrap underline underline-offset-4 hover:no-underline">
                      See reputation
                    </Link>
                  )}
                </>
              }
            />
          ) : (
            <DomainChip status={domain.status} />
          )
        }
        meta={
          <>
            {domain.verifiedAt ? `Verified ${dayLabel(domain.verifiedAt, zone)}` : `Added ${dayLabel(domain.createdAt, zone)}`}
            {domain.lastCheckedAt ? (
              <>
                {", checked "}
                <Time date={domain.lastCheckedAt} />.
              </>
            ) : (
              ", never checked."
            )}
          </>
        }
        actions={
          <>
            {unverified && domain.verifiable ? (
              <form action={verify.formAction}>
                <input type="hidden" name="id" value={domain.id} />
                <Button type="submit" size="md" disabled={verify.pending}>
                  {verify.pending ? "Checking…" : "Verify now"}
                </Button>
              </form>
            ) : null}
            <OverflowMenu
              actions={[
                !unverified &&
                  domain.verifiable && {
                    label: verify.pending ? "Checking…" : "Check verification again",
                    disabled: verify.pending,
                    onSelect: () => {
                      const form = new FormData();
                      form.set("id", domain.id);
                      startTransition(() => verify.formAction(form));
                    },
                  },
                {
                  label: `Delete ${domain.name}`,
                  destructive: true,
                  disabled: !canManage || Boolean(domain.deleteBlock),
                  reason: !canManage ? "Your role doesn't let you delete a domain." : domain.deleteBlock?.message,
                  onSelect: () => setConfirming(true),
                },
              ]}
            />
          </>
        }
      />

      <div className="flex flex-col gap-4 pb-6">
        {domain.stall ? (
          <Alert
            tone="danger"
            title="Sending is paused"
            action={
              <form action={release.formAction}>
                <input type="hidden" name="id" value={domain.id} />
                <RoleGate allowed={canManage} reason="Your role doesn't let you resume sending.">
                  <Button type="submit" variant="secondary" size="sm" disabled={release.pending}>
                    {release.pending ? "Releasing…" : "Release"}
                  </Button>
                </RoleGate>
              </form>
            }
          >
            <p>{domain.stall.summary}</p>
            <p className="mt-1 text-muted-foreground">
              Paused <Time date={domain.stall.stalledAt} />. New sends queue and go out once it&apos;s released.
            </p>
          </Alert>
        ) : null}

        {section !== "reputation" && standing ? <ReputationSummary href={reputationHref} summary={standing} /> : null}

        <SegmentedLinks
          label="Section"
          options={DOMAIN_SECTIONS.map((option) => ({
            href: `/domains/${domain.id}/${option}`,
            label: SECTION_LABEL[option],
            active: option === section,
          }))}
        />
      </div>

      {children}


      <ConfirmDialog
        open={confirming && canManage && !domain.deleteBlock}
        onOpenChange={(open) => !open && setConfirming(false)}
        onCloseAutoFocus={opener.restore}
        title={`Delete ${domain.name}?`}
        consequence={consequence}
        confirmLabel="Delete domain"
        tone="destructive"
        loading={remove.pending}
        onConfirm={() => {
          const form = new FormData();
          form.set("id", domain.id);
          startTransition(() => remove.formAction(form));
        }}
        cancelLabel="Cancel"
      >
        {liveKeys.length > 0 ? (
          <ul className="mt-2 list-disc pl-5 text-sm text-foreground-soft">
            {liveKeys.map((key) => (
              <li key={key.id} className="font-mono">
                {key.name}
              </li>
            ))}
          </ul>
        ) : null}
      </ConfirmDialog>
    </>
  );
}

/** "Deletes its 2 messages and 1 list." Null when there's no history to lose. */
function historyNote(contents: DomainDetailData["deleteContents"]): string | null {
  if (!contents) return null;
  const parts = [
    contents.messages > 0 ? `${contents.messages} ${contents.messages === 1 ? "message" : "messages"}` : null,
    contents.lists > 0 ? `${contents.lists} ${contents.lists === 1 ? "list" : "lists"}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `Deletes its ${parts.join(" and ")}.` : null;
}

/** Only a warning earns space above the sections. Paused has the stall alert; the chip covers the rest. */
function ReputationSummary({ href, summary }: { href: string; summary: DomainStandingSummary }) {
  const { standing, lead } = summary;
  if ((standing !== "watch" && standing !== "at_risk") || !lead) return null;

  return (
    <Callout tone={standing === "at_risk" ? "danger" : "warn"} title={lead.title}>
      <p>{lead.action}</p>
      <p className="mt-2">
        <Link href={href} className="underline underline-offset-4 hover:no-underline">
          See reputation
        </Link>
      </p>
    </Callout>
  );
}
