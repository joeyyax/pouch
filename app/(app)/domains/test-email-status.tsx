"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { Logo } from "@/components/logo";
import { Icon } from "@/components/ui/icon";
import { PULSE_OR_RING } from "@/lib/motion";
import type { MessageStatus } from "@/lib/db/schema/messages";
import { LiveIndicator } from "../messages/live-indicator";
import { useMessageStatus } from "./use-message-status";

const TERMINAL = new Set<MessageStatus>(["delivered", "bounced", "complained", "failed"]);

type RetryLocal = "bounce" | "defer" | "slow";

const RETRY_OPTIONS: { local: RetryLocal; label: string }[] = [
  { local: "bounce", label: "Bounced" },
  { local: "defer", label: "Deferred" },
  { local: "slow", label: "Slow" },
];

/** Per-outcome copy, more specific than the bare lifecycle word. */
const TERMINAL_COPY: Record<MessageStatus, { headline: string; detail: string } | undefined> = {
  queued: undefined,
  sent: undefined,
  delivered: { headline: "Delivered.", detail: "The receiving server accepted it." },
  bounced: { headline: "Bounced.", detail: "The receiving server refused it. No more attempts." },
  deferred: { headline: "Still trying.", detail: "The recipient's server asked to try again." },
  failed: { headline: "Failed.", detail: "The provider couldn't deliver it." },
  complained: { headline: "Complained.", detail: "The recipient marked it as spam." },
};

function localPart(address: string): string {
  return address.split("@")[0]?.toLowerCase() ?? "";
}

/**
 * The one deliberately satisfying moment — a message completing its whole lifecycle live is
 * rare enough to earn some presence. A soft ring blooms out and fades behind a spring-eased
 * circle with a little overshoot, then the check draws in. Gated on reduced motion throughout;
 * still no confetti, no emoji, no color outside the success tokens already used elsewhere.
 */
function DeliveredMark() {
  const reduced = useReducedMotion();
  return (
    <div className="relative flex size-9 shrink-0 items-center justify-center">
      {!reduced ? (
        <motion.span
          aria-hidden
          initial={{ scale: 0.6, opacity: 0.5 }}
          animate={{ scale: 2, opacity: 0 }}
          transition={{ duration: 0.65, delay: 0.05, ease: "easeOut" }}
          className="absolute inset-0 rounded-full bg-success"
        />
      ) : null}
      <motion.div
        initial={reduced ? false : { scale: 0.4, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={reduced ? undefined : { type: "spring", stiffness: 340, damping: 14, mass: 0.6 }}
        className="relative flex size-9 items-center justify-center rounded-full bg-success-soft text-success-ink"
      >
        <svg viewBox="0 0 24 24" fill="none" className="size-5" aria-hidden>
          <motion.path
            d="m5 13 4 4L19 7"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={reduced ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.3, delay: 0.24, ease: "easeOut" }}
          />
        </svg>
      </motion.div>
    </div>
  );
}

/** Bounced or failed was the point of the test. Muted, not red — an outcome, not an incident. */
function OutcomeMark() {
  const reduced = useReducedMotion();
  return (
    <motion.div
      initial={reduced ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-tertiary"
    >
      <Icon name="info" aria-hidden className="size-5" />
    </motion.div>
  );
}

/** Deferred is "still trying", not a failure — warn tone, not danger, and no terminal framing. */
function DeferredMark() {
  const reduced = useReducedMotion();
  return (
    <motion.div
      initial={reduced ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-warning-soft text-warning"
    >
      <Icon name="clock" aria-hidden className="size-5" />
    </motion.div>
  );
}

const STEPS: { key: MessageStatus; label: string }[] = [
  { key: "queued", label: "Queued" },
  { key: "sent", label: "Sent" },
];

/** The current step's pulse is what says "this one, now" — reduced motion gets a static halo instead of a plain dot. */
function StepDot({ done, current }: { done: boolean; current: boolean }) {
  return (
    <span
      aria-hidden
      className={`size-1.5 rounded-full ${
        done ? "bg-success" : current ? `bg-primary ring-primary/40 ${PULSE_OR_RING}` : "bg-border"
      }`}
    />
  );
}

export function TestEmailStatus({
  messageId,
  initialStatus,
  toAddress,
  viewHref,
  onRetry,
  onDismiss,
  retryDisabled,
  cooldownSeconds,
  justSent = false,
}: {
  messageId: string;
  initialStatus: MessageStatus;
  /** The address this message was sent to — used for the "waiting on" copy and retry suggestions. */
  toAddress: string;
  viewHref: string;
  onRetry: (local: RetryLocal) => void;
  onDismiss: () => void;
  retryDisabled: boolean;
  cooldownSeconds: number;
  /** Accepted in this view, not picked back up after a reload: the mark plays the send once. */
  justSent?: boolean;
}) {
  const { status, stream } = useMessageStatus(messageId, initialStatus);
  const terminal = TERMINAL.has(status);
  const deferred = status === "deferred";
  const settled = terminal || deferred;
  const stepIndex = STEPS.findIndex((step) => step.key === status);
  const copy = TERMINAL_COPY[status];

  const usedLocal = localPart(toAddress);
  const retryChoices = RETRY_OPTIONS.filter((option) => option.local !== usedLocal);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {!settled ? (
            <div className="flex items-center gap-3">
              <Logo className="size-9 shrink-0 p-0.5" motion={justSent ? ["sent", "wait"] : "wait"} decorative />
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  {STEPS.map((step, index) => (
                    <span key={step.key} className="flex items-center gap-2">
                      {index > 0 ? <span className="h-px w-4 bg-border" aria-hidden /> : null}
                      <span className="flex items-center gap-1.5">
                        <StepDot done={index < stepIndex} current={index === stepIndex} />
                        <span
                          className={`type-body-sm ${index === stepIndex ? "text-foreground" : "text-muted-foreground"}`}
                        >
                          {step.label}
                        </span>
                      </span>
                    </span>
                  ))}
                </div>
                <LiveIndicator state={stream} />
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              {status === "delivered" ? <DeliveredMark /> : deferred ? <DeferredMark /> : <OutcomeMark />}
              <div className="flex flex-col gap-0.5">
                <span aria-live="polite" aria-atomic className="type-body font-semibold text-foreground">
                  {copy?.headline}
                </span>
                <span className="type-body-sm text-muted-foreground">{copy?.detail}</span>
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onDismiss}
          title="Stop watching this test"
          aria-label="Stop watching this test"
          className="shrink-0 rounded-full p-1 text-tertiary transition-colors hover:text-foreground"
        >
          <Icon name="close" aria-hidden className="size-4" />
        </button>
      </div>

      {!settled ? (
        <p aria-live="off" className="type-body-sm text-muted-foreground">
          {stream === "off"
            ? "Live updates stopped. Check the message page for its current status."
            : stream === "offline"
              ? "You’re offline. This picks back up once you’re connected."
              : status === "queued"
                ? "Usually lands in a few seconds."
                : `Waiting on ${toAddress}.`}
        </p>
      ) : null}

      <p>
        <Link href={viewHref} className="type-body-sm text-primary-strong underline underline-offset-4">
          View message →
        </Link>
      </p>

      {terminal ? (
        <p className="type-body-sm text-muted-foreground">
          Opens and clicks aren&apos;t tracked.
        </p>
      ) : null}

      {settled && retryChoices.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <span className="type-body-sm text-muted-foreground">Try another outcome:</span>
          {retryChoices.map((option) => (
            <button
              key={option.local}
              type="button"
              disabled={retryDisabled}
              onClick={() => onRetry(option.local)}
              className="rounded-full bg-secondary px-2.5 py-1 type-body-sm text-tertiary transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {option.label}
            </button>
          ))}
          {cooldownSeconds > 0 ? (
            <span className="type-body-sm text-muted-foreground">Try again in {cooldownSeconds}s</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
