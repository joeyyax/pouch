"use client";

import { useState, type RefObject } from "react";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Chip, chipVariants } from "@/components/ui/chip";
import { CopyField } from "@/components/ui/copy-field";
import { DetailPanel } from "@/components/ui/detail-panel";
import { EmptyState } from "@/components/ui/empty-state";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { Code } from "@/components/code";
import { KeyValueList } from "@/components/ui/key-value-list";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";
import { StatusMark } from "@/components/ui/status-dot";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "@/components/ui/tabs";
import { TextLink } from "@/components/ui/text-link";
import { Timeline } from "@/components/ui/timeline";
import { Tooltip } from "@/components/ui/tooltip";
import type { MessageBody, MessageDetailData } from "@/lib/dashboard/views/messages";
import { withheldSentence } from "@/lib/messages/body-state";
import { byteLabel, clockTime, dayLabel, durationLabel, messageSizeLabel } from "@/lib/format/time";
import { cn } from "@/lib/utils";
import { timelineEntry } from "./message-detail-timeline";
import { useTimeZone } from "../_ui/time-zone";
import { ZoneNote } from "../_ui/zone-note";
import { heldLink, heldSentence } from "./message-hold";
import { StatusChip } from "../_ui/status";
import { Term } from "../_ui/term";
import { CopyOnHover } from "../_ui/copy-on-hover";
import { Time } from "../_ui/time";
import { BodyFrame } from "../_ui/body-frame";
import { Snippet } from "../_ui/snippet";
import { loadMessageBodyAction, loadMessageWithBodyAction } from "./actions";
import { useLazy } from "./use-lazy";
import { ResendButton } from "./resend-button";

function Pre({ children, wrap = false }: { children: React.ReactNode; wrap?: boolean }) {
  return (
    <pre
      className={cn(
        "squircle overflow-x-auto rounded-xl bg-background-deep p-4 font-mono text-2xs text-foreground-soft",
        wrap && "whitespace-pre-wrap break-words",
      )}
    >
      {children}
    </pre>
  );
}

/** Says which of the four things happened to the body, and never pretends it's still there. */
function BodyGone({ body }: { body: Exclude<MessageBody, { state: "available" }> }) {
  const zone = useTimeZone();
  if (body.state === "withheld") {
    return (
      <EmptyState
        icon="eye-off"
        title="Body withheld"
        description={withheldSentence(body.reason)}
      />
    );
  }
  if (body.state === "purged") {
    return body.purgedAt ? (
      <EmptyState
        icon="block"
        title="Body shredded"
        description={`Shredded past the retention window on ${dayLabel(body.purgedAt, zone)}. The delivery record stays.`}
      />
    ) : (
      <EmptyState
        icon="block"
        title="Body unreadable"
        description="This message predates body encryption, so there's no key to read it with. The delivery record stays."
      />
    );
  }
  if (body.state === "expired") {
    return (
      <EmptyState
        icon="clock"
        title="Body past retention"
        description={`Retention ended ${dayLabel(body.keptUntil, zone)}. Events are kept, so the timeline is complete.`}
      />
    );
  }
  return (
    <EmptyState
      icon="warning"
      title="Body couldn’t be read"
      description="Object storage didn’t answer. The body may still be there — reload to ask again."
    />
  );
}

/** A body tab, off with the reason on hover when the message has no such part. */
function BodyTab({ value, label, missing }: { value: string; label: string; missing: string | null }) {
  if (!missing) return <TabsTrigger value={value}>{label}</TabsTrigger>;
  return (
    <Tooltip content={missing}>
      <span className="inline-flex cursor-not-allowed">
        <TabsTrigger value={value} disabled aria-description={missing} className="pointer-events-none opacity-50">
          {label}
        </TabsTrigger>
      </span>
    </Tooltip>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <SkeletonGroup label={label} className="flex flex-col gap-2">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-40 w-full" />
    </SkeletonGroup>
  );
}

function LoadFailed({ what }: { what: string }) {
  return <EmptyState icon="warning" title={`${what} didn’t load`} description="Open the message again to retry." />;
}

/** `GET /v1/emails/:id` without and with the body: each request beside the response it returns. The body side loads when it opens. */
function ApiExchanges({ id, api }: { id: string; api: MessageDetailData["api"] }) {
  const [side, setSide] = useState("plain");
  const withBody = useLazy(side === "body", () => loadMessageWithBodyAction(id));
  return (
    <TabsRoot value={side} onValueChange={setSide}>
      <TabsList size="sm" aria-label="Response">
        <TabsTrigger value="plain">Without body</TabsTrigger>
        <TabsTrigger value="body">With body</TabsTrigger>
      </TabsList>
      <TabsContent value="plain" className="flex flex-col gap-3">
        <Snippet languages={api.plain.requests} />
        <Pre>
          <Code language="json" code={api.plain.response} />
        </Pre>
      </TabsContent>
      <TabsContent value="body" className="flex flex-col gap-3">
        <Snippet languages={api.withBodyRequests} />
        {withBody.state === "loaded" ? (
          <Pre>
            <Code language="json" code={withBody.value.response} />
          </Pre>
        ) : withBody.state === "failed" ? (
          <LoadFailed what="The response" />
        ) : (
          <Loading label="Loading the response" />
        )}
      </TabsContent>
    </TabsRoot>
  );
}

const FIELD_LABEL: Record<"to" | "cc" | "bcc", string> = { to: "To", cc: "Cc", bcc: "Bcc" };

export function MessageDetail({
  message,
  onClose,
  onPrevious,
  onNext,
  onSelectTag,
  fallbackFocus,
}: {
  message: MessageDetailData;
  onClose: () => void;
  /** Steps to the message above in the list. */
  onPrevious?: () => void;
  onNext?: () => void;
  /** Filters the list to a tag clicked here. Omit to render tags as plain chips. */
  onSelectTag?: (tag: string) => void;
  /** Takes focus when the row that opened the panel isn't on screen — a link straight to the id. */
  fallbackFocus?: RefObject<HTMLElement | null>;
}) {
  const zone = useTimeZone();
  const { recipients } = message;
  const first = recipients[0];
  const only = recipients.length === 1 ? first : undefined;
  const [chosen, setTab] = useState("html");
  const loaded = useLazy(chosen === "html" || chosen === "text", () => loadMessageBodyAction(message.id));
  const view = loaded.state === "loaded" ? loaded.value : null;
  const body = view?.body ?? null;
  const available = body?.state === "available" ? body : null;
  const attachments = available?.attachments ?? [];
  const sizeLabel = messageSizeLabel(message.size);
  // With one part missing, its tab is off and the other opens. With both missing, both explain.
  const noHtml = Boolean(available && !available.html && available.text);
  const noText = Boolean(available && !available.text && available.html);
  const tab = chosen === "html" && noHtml ? "text" : chosen === "text" && noText ? "html" : chosen;

  const bodyTab = (part: "html" | "text") =>
    loaded.state === "failed" ? (
      <LoadFailed what="The body" />
    ) : !body ? (
      <Loading label="Loading the body" />
    ) : body.state !== "available" ? (
      <BodyGone body={body} />
    ) : part === "text" ? (
      body.text ? (
        <Pre wrap>{body.text}</Pre>
      ) : (
        <EmptyState icon="file" title="No text part" description="This message was sent as HTML only." />
      )
    ) : body.html ? (
      <>
        <BodyFrame html={body.html} title={message.subject} className="h-[70dvh] md:h-auto md:min-h-72 md:flex-1" />
        {view?.framed ? (
          <p className="type-body-sm mt-2 text-muted-foreground">
            {view.frameChanged
              ? `Wrapped in ${message.domainName}'s layout as it is now. It changed after this was sent, so the recipient's frame differs.`
              : `Wrapped in ${message.domainName}'s layout, the way the worker sends it.`}
          </p>
        ) : null}
      </>
    ) : (
      <EmptyState icon="file" title="No HTML part" description="This message was sent as plain text only." />
    );

  return (
    <TabsRoot value={tab} onValueChange={setTab}>
      <DetailPanel
        open
        onOpenChange={(next) => !next && onClose()}
        onPrevious={onPrevious}
        onNext={onNext}
        onCloseAutoFocus={(event) => {
          // The row is a fresh node by now, so Radix's own target is detached.
          event.preventDefault();
          const row = document.querySelector<HTMLElement>(`[data-row-key="${message.id}"]`);
          (row ?? fallbackFocus?.current)?.focus();
        }}
        title={message.subject}
        actions={<ResendButton key={message.id} messageId={message.id} blocked={message.resendBlocked} />}
        chip={
          <span className="flex items-center gap-1.5">
            <StatusChip
              status={message.status}
              stuck={message.stuck}
              explain={message.stall ? heldSentence(message.stall, message.domainName) : true}
              announce
            />
            {message.testMode ? (
              <Term chip term="test">
                <Chip tone="signal">test</Chip>
              </Term>
            ) : null}
          </span>
        }
        description={
          <>
            {`to ${first?.address ?? "—"}${recipients.length > 1 ? ` and ${recipients.length - 1} more` : ""} · from ${
              message.fromName ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress
            } · `}
            <Time date={message.createdAt} />
          </>
        }
        tabs={
          <TabsList size="sm">
            <BodyTab value="html" label="HTML" missing={noHtml ? "Sent as plain text only." : null} />
            <BodyTab value="text" label="Text" missing={noText ? "Sent as HTML only." : null} />
            <TabsTrigger value="headers">Headers</TabsTrigger>
            <TabsTrigger value="json">JSON</TabsTrigger>
          </TabsList>
        }
        sidebar={
          <div className="flex flex-col gap-6">
            <section>
              <p className="type-label mb-3 flex items-center justify-between gap-3 text-muted-foreground">
                Timeline
                <ZoneNote />
              </p>
              {message.events.length > 0 ? (
                <Timeline dense items={message.events.map((event) => timelineEntry(event, zone, message.fromAddress))} />
              ) : (
                <p className="type-body-sm text-muted-foreground">No events recorded yet.</p>
              )}
              {message.nextAttemptAt ? (
                <p className="type-body-sm mt-3 text-foreground-soft">
                  Next retry {clockTime(message.nextAttemptAt, zone)}.
                </p>
              ) : null}
            </section>

            <section>
              <p className="type-label mb-3 text-muted-foreground">
                {message.replies.length === 0
                  ? "Replies"
                  : `Replies (${message.replies.length})`}
              </p>
              {message.replies.length > 0 ? (
                <ul className="flex flex-col gap-2">
                  {message.replies.map((reply) => (
                    <li key={reply.id}>
                      <TextLink href={`/inbound/${reply.id}`}>
                        <span className="flex flex-col">
                          <span className="text-sm">{reply.subject || "(no subject)"}</span>
                          <span className="type-body-sm text-foreground-soft">
                            {reply.from} · <Time date={reply.receivedAt} />
                          </span>
                        </span>
                      </TextLink>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="type-body-sm text-muted-foreground">No replies. Most sends don’t get one.</p>
              )}
            </section>

            <section>
              <p className="type-label mb-3 text-muted-foreground">
                {recipients.length === 1 ? "Recipient" : `Recipients (${recipients.length})`}
              </p>
              <div className="flex flex-col gap-3">
                {only ? (
                  <>
                    {/* A full-width CopyField, not a KeyValueList row: mono values there
                        truncate, and the address is the thing to paste. */}
                    <CopyField value={only.address} label="address" />
                    <KeyValueList
                      items={[
                        {
                          label: "Status",
                          value: only.suppressed ? (
                            <Chip tone="issue">suppressed</Chip>
                          ) : (
                            <span className="text-muted-foreground">Not suppressed</span>
                          ),
                        },
                        {
                          label: "Messages",
                          value: (
                            <TextLink href={`/messages?address=${encodeURIComponent(only.address)}`}>
                              {message.messageCount === null ? "All to this address" : `${message.messageCount} to this address`}
                            </TextLink>
                          ),
                        },
                      ]}
                    />
                  </>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {recipients.map((entry) => (
                      <li key={`${entry.field}:${entry.address}`} className="flex flex-col gap-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="type-label text-muted-foreground">{FIELD_LABEL[entry.field]}</span>
                          <CopyOnHover value={entry.address} label="address">
                            <TextLink href={`/messages?address=${encodeURIComponent(entry.address)}`}>
                              <span className="font-mono text-sm">{entry.address}</span>
                            </TextLink>
                          </CopyOnHover>
                          {entry.suppressed ? <Chip tone="issue">suppressed</Chip> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {recipients
                  .filter((entry) => entry.suppressed && entry.suppressedAt)
                  .map((entry) => (
                    <p key={entry.address} className="type-body-sm text-foreground-soft">
                      {only ? "Suppressed" : `${entry.address} suppressed`} on {dayLabel(entry.suppressedAt as Date, zone)}. Sends
                      to it fail until you remove it.{" "}
                      <TextLink href={`/suppressions?address=${encodeURIComponent(entry.address)}`}>
                        Open the suppression
                      </TextLink>
                    </p>
                  ))}

              </div>
            </section>

            <section>
              <p className="type-label mb-3 text-muted-foreground">Send</p>
              <KeyValueList
                items={[
                  { label: "Message id", value: message.id, copy: message.id, mono: true },
                  ...(message.resentFrom
                    ? [
                        {
                          label: "Resent from",
                          value: (
                            <TextLink href={`/messages/${message.resentFrom}`}>
                              <span className="font-mono text-sm">{message.resentFrom}</span>
                            </TextLink>
                          ),
                        },
                      ]
                    : []),
                  {
                    label: "Domain",
                    value: (
                      <Link href={`/domains/${message.domainId}`} className="underline underline-offset-4">
                        {message.domainName}
                      </Link>
                    ),
                  },
                  {
                    label: "Key",
                    value:
                      message.keyId && message.keyName ? (
                        <span className="flex min-w-0 items-center gap-1.5">
                          <CopyOnHover value={message.keyName} label="key name" className="font-mono">
                            <Link href={`/keys/${message.keyId}`} className="underline underline-offset-4">
                              {message.keyName}
                            </Link>
                          </CopyOnHover>
                          {message.keyRevoked ? <span className="shrink-0 text-muted-foreground">revoked</span> : null}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">No key</span>
                      ),
                  },
                  { label: "Attempts", value: String(message.attempts) },
                  ...(sizeLabel ? [{ label: "Size", value: sizeLabel }] : []),
                  ...(message.providerMessageId
                    ? [
                        {
                          label: "Provider id",
                          value: message.providerMessageId,
                          copy: message.providerMessageId,
                          mono: true,
                        },
                      ]
                    : []),
                  ...(message.tags.length > 0
                    ? [
                        {
                          label: "Tags",
                          value: (
                            <span className="flex flex-wrap gap-1">
                              {message.tags.map((tag) =>
                                onSelectTag ? (
                                  <button
                                    key={tag}
                                    type="button"
                                    onClick={() => onSelectTag(tag)}
                                    className={cn(chipVariants({ tone: "value" }), "hover:bg-muted-foreground/20", FOCUS_RING)}
                                  >
                                    {tag}
                                  </button>
                                ) : (
                                  <Chip key={tag} tone="value">
                                    {tag}
                                  </Chip>
                                ),
                              )}
                            </span>
                          ),
                        },
                      ]
                    : []),
                ]}
              />
            </section>

            {message.resends.length > 0 ? (
              <section>
                <p className="type-label mb-3 text-muted-foreground">{`Resends (${message.resends.length})`}</p>
                <ul className="flex flex-col gap-2">
                  {message.resends.map((copy) => (
                    <li key={copy.id} className="flex flex-wrap items-center gap-1.5">
                      <TextLink href={`/messages/${copy.id}`}>
                        <span className="font-mono text-sm">{copy.id}</span>
                      </TextLink>
                      <StatusChip status={copy.status} />
                      <span className="type-body-sm text-foreground-soft">
                        <Time date={copy.createdAt} />
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {message.facts.length > 0 ? (
              <section>
                <p className="type-label mb-3 text-muted-foreground">Fun facts</p>
                <ul className="flex flex-col gap-2">
                  {message.facts.map((fact) => (
                    <li key={fact.text} className="type-body-sm flex gap-2 text-foreground-soft">
                      <span className="flex h-5 items-center">
                        <StatusMark tone={fact.tone} />
                      </span>
                      <span>{fact.text}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        }
      >
        <div className="flex flex-col gap-4 md:h-full">
          {message.stall ? (
            <Alert tone="warn" title={heldSentence(message.stall, message.domainName)}>
              <TextLink href={heldLink(message.stall, message.domainId, message.domainName).href}>
                {heldLink(message.stall, message.domainId, message.domainName).label}
              </TextLink>
            </Alert>
          ) : message.stuck ? (
            <Alert tone="warn" title={`Queued for ${durationLabel(message.createdAt)}`}>
              The worker hasn’t picked it up.
            </Alert>
          ) : null}

          {message.abandonedAt ? (
            <Alert tone="info" title="No delivery confirmation">
              {message.sentAt ? (
                <>
                  Accepted by the provider <Time date={message.sentAt} />.{" "}
                </>
              ) : null}
              It most likely landed. The provider never confirmed it.
            </Alert>
          ) : null}

          {message.warnings.map((warning) => (
            <Alert key={`${warning.code}:${warning.address}`} tone="warn" title={`Recipient history flagged ${warning.address} at accept time`}>
              {warning.message}
            </Alert>
          ))}

          {message.failureReason && message.status === "failed" ? (
            <Alert tone="danger" title="The provider rejected it">
              <span className="font-mono text-sm">{message.failureReason}</span>
              <span className="mt-2 block">
                {message.attempts} attempts{message.keyName ? ` with ${message.keyName}` : ""}. Retries are up to the caller.
              </span>
            </Alert>
          ) : null}

          {attachments.length > 0 ? (
            <p className="type-body-sm text-muted-foreground">
              {attachments.length} attachment{attachments.length === 1 ? "" : "s"}:{" "}
              {attachments.map((file) => `${file.filename}, ${byteLabel(file.bytes)}`).join(" · ")}
            </p>
          ) : message.envelope.attachmentCount > 0 ? (
            <p className="type-body-sm text-muted-foreground">
              {message.envelope.attachmentCount} attachment
              {message.envelope.attachmentCount === 1 ? "" : "s"}, stored with the body.
            </p>
          ) : null}

          <TabsContent value="html" className="md:min-h-0 md:flex-1 md:flex-col md:data-[state=active]:flex">
            {bodyTab("html")}
          </TabsContent>
          <TabsContent value="text">{bodyTab("text")}</TabsContent>
          <TabsContent value="headers">
            <Pre>
              <Code language="http" code={message.headers} />
            </Pre>
          </TabsContent>
          <TabsContent value="json">
            <ApiExchanges id={message.id} api={message.api} />
          </TabsContent>
        </div>
      </DetailPanel>
    </TabsRoot>
  );
}
