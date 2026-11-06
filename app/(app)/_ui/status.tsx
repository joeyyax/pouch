import Link from "next/link";
import type { ReactNode } from "react";
import { Chip } from "@/components/ui/chip";
import { Icon } from "@/components/ui/icon";
import { StatusDot, sentenceCase, type StatusDotTone } from "@/components/ui/status-dot";
import type { MessageStatus } from "@/lib/db/schema/messages";
import type { DomainStatus } from "@/lib/db/schema/domains";
import { STANDING_LABEL, type Standing } from "@/lib/reputation/standing";
import { cn } from "@/lib/utils";
import { GLOSSARY, type GlossaryTerm } from "./glossary";
import { Term } from "./term";

/** Chip beside a title or as a flag in a cell; dot and label in a state's own column. A normal state skips the chip. */
export type StatusShape = "chip" | "dot";

function Stateful({
  shape,
  tone,
  pending = false,
  label,
  term,
  explain,
  title,
  icon,
  quiet = false,
}: {
  shape: StatusShape;
  tone: StatusDotTone;
  pending?: boolean;
  label: string;
  term?: GlossaryTerm;
  explain?: true | ReactNode;
  title?: string;
  icon?: ReactNode;
  /** A normal state where a chip would go: muted text, since chips flag exceptions. */
  quiet?: boolean;
}) {
  const definition = explain === true ? undefined : explain;
  if (shape === "chip" && quiet) {
    const text = <span className="text-sm text-muted-foreground">{sentenceCase(label)}</span>;
    return explain ? (
      <Term term={term} definition={definition} className="text-muted-foreground">
        {text}
      </Term>
    ) : (
      <span title={title}>{text}</span>
    );
  }
  if (shape === "dot") {
    const text = sentenceCase(label);
    return (
      <StatusDot tone={tone} pending={pending} title={explain ? undefined : title}>
        {explain ? (
          <Term term={term} definition={definition}>
            {text}
          </Term>
        ) : (
          text
        )}
      </StatusDot>
    );
  }
  const chip = (
    <Chip tone={tone} title={explain ? undefined : title}>
      {icon}
      {label}
    </Chip>
  );
  return explain ? (
    <Term chip term={term} definition={definition}>
      {chip}
    </Term>
  ) : (
    chip
  );
}

// Color encodes the class of state, not the individual state, so seven
// lifecycle words read as four meanings at a glance.
const MESSAGE_TONE: Record<MessageStatus, StatusDotTone> = {
  queued: "neutral",
  sent: "neutral",
  delivered: "good",
  deferred: "warn",
  bounced: "issue",
  complained: "issue",
  failed: "issue",
};

export function StatusChip({
  status,
  stuck = false,
  announce = false,
  explain,
  shape = "chip",
}: {
  status: MessageStatus;
  stuck?: boolean;
  /** Opens an explanation: `true` for the glossary's, or a contextual one. */
  explain?: true | ReactNode;
  /** On where live updates rewrite the chip in place, so the change is spoken, not just drawn. */
  announce?: boolean;
  shape?: StatusShape;
}) {
  // A message stuck past the retry window is our problem, and neutral hides it.
  const tone = stuck ? "warn" : MESSAGE_TONE[status];
  const mark = (
    <Stateful shape={shape} tone={tone} pending={!stuck && status === "queued"} label={status} term={status} explain={explain} />
  );

  return announce ? (
    <span aria-live="polite" aria-atomic>
      {mark}
    </span>
  ) : (
    mark
  );
}

const DOMAIN_TONE: Record<DomainStatus, StatusDotTone> = {
  pending: "warn",
  verified: "good",
  failed: "issue",
};

export function DomainChip({ status, shape = "chip" }: { status: DomainStatus; shape?: StatusShape }) {
  return <Stateful shape={shape} tone={DOMAIN_TONE[status]} pending={status === "pending"} label={status} />;
}

const STANDING_TONE: Record<Standing, StatusDotTone> = {
  healthy: "good",
  watch: "warn",
  at_risk: "issue",
  paused: "issue",
};

/** The reason, when there is one, then what the standing means. */
export function standingNote(standing: Standing, reason?: string | null): string {
  return reason && standing !== "healthy" ? `${reason} ${GLOSSARY[standing]}` : GLOSSARY[standing];
}

export function StandingChip({
  standing,
  explain,
  shape = "chip",
}: {
  standing: Standing;
  /** Opens an explanation: `true` for the glossary's, or a contextual one. */
  explain?: true | ReactNode;
  shape?: StatusShape;
}) {
  return (
    <Stateful
      shape={shape}
      tone={STANDING_TONE[standing]}
      label={STANDING_LABEL[standing]}
      quiet={standing === "healthy"}
      term={standing}
      explain={explain}
      title={`Reputation: ${STANDING_LABEL[standing]}`}
      icon={standing === "paused" ? <Icon name="pause" aria-hidden className="size-3" /> : null}
    />
  );
}

export function KeyChip({
  mode,
  revoked,
  shape = "chip",
  explain,
}: {
  mode: "live" | "test";
  revoked?: boolean;
  shape?: StatusShape;
  /** Opens what the mode means: `true` for the glossary's, or a contextual one. */
  explain?: true | ReactNode;
}) {
  if (revoked) return <Stateful shape={shape} tone="neutral" label="revoked" />;
  return (
    <Stateful shape={shape} tone={mode === "live" ? "good" : "signal"} label={mode} term={mode} explain={explain} quiet={mode === "live"} />
  );
}

/** Follows a suppressed address wherever it appears, and links to the row. */
export function SuppressedMarker({ address, className }: { address: string; className?: string }) {
  return (
    <Link
      href={`/suppressions?address=${encodeURIComponent(address)}`}
      title={`${address} is suppressed`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full bg-danger-soft px-1.5 py-0.5 align-middle text-2xs font-semibold text-danger",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
        className,
      )}
    >
      <Icon name="block" aria-hidden className="size-3" />
      suppressed
    </Link>
  );
}
