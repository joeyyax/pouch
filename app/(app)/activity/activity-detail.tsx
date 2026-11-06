"use client";

import { Code } from "@/components/code";
import { Chip } from "@/components/ui/chip";
import { DetailPanel } from "@/components/ui/detail-panel";
import { KeyValueList } from "@/components/ui/key-value-list";
import { actorName, OUTCOME_LABELS, OUTCOME_TONE } from "@/lib/activity/labels";
import { phraseFor } from "@/lib/activity/taxonomy";
import type { ActivityDetailData } from "@/lib/activity/types";
import { Time } from "../_ui/time";

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre className="squircle overflow-x-auto rounded-xl bg-background-deep p-4 font-mono text-2xs text-foreground-soft">
      {children}
    </pre>
  );
}

export function ActivityDetail({
  item,
  onClose,
  onPrevious,
  onNext,
}: {
  item: ActivityDetailData;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const phrase = phraseFor(item.action);

  return (
    <DetailPanel
      // One record, a few fields: sized to its content rather than the message panel's full frame.
      className="md:bottom-auto md:max-w-3xl"
      open
      onOpenChange={(next) => !next && onClose()}
      onPrevious={onPrevious}
      onNext={onNext}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        const row = document.querySelector<HTMLElement>(`[data-row-key="${item.id}"]`);
        row?.focus();
      }}
      // Plain text, so the panel's truncation ends in an ellipsis at phone width.
      title={`${actorName(item.actor)} ${phrase.text}${!phrase.standalone && item.subjectLabel ? ` ${item.subjectLabel}` : ""}`}
      chip={<Chip tone={OUTCOME_TONE[item.outcome]}>{OUTCOME_LABELS[item.outcome]}</Chip>}
      description={<Time date={item.createdAt} />}
    >
      <div className="flex flex-col gap-4">
        <KeyValueList
          items={[
            { label: "Action", value: item.action, mono: true },
            ...(item.subjectLabel
              ? [
                  {
                    label: "Subject",
                    value: item.subjectHref ? (
                      <a href={item.subjectHref} className="underline underline-offset-4">
                        {item.subjectLabel}
                      </a>
                    ) : (
                      item.subjectLabel
                    ),
                  },
                ]
              : []),
            ...(item.address ? [{ label: "Address", value: item.address, mono: true, copy: item.address }] : []),
          ]}
        />

        {item.metadata && Object.keys(item.metadata).length > 0 ? (
          <section>
            <p className="type-label mb-2 text-muted-foreground">Details</p>
            <Pre>
              <Code language="json" code={JSON.stringify(item.metadata, null, 2)} />
            </Pre>
          </section>
        ) : null}
      </div>
    </DetailPanel>
  );
}
