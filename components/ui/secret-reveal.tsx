"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyField } from "@/components/ui/copy-field";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

// SecretReveal — the shown-once panel. It owns its own copy button rather
// than composing CopyField's, because whether the value has been copied is
// the thing that gates closing: leaving without it means the secret is gone.
// The confirm on the way out is the only guard, and it states that plainly.
export function SecretReveal({
  value,
  label = "key",
  title,
  description,
  warning = "Copy it now. It isn’t shown again.",
  closeLabel = "Done",
  onClose,
  children,
  className,
}: {
  value: string;
  /** Names what this is, for the copy button and the confirm. */
  label?: string;
  title: ReactNode;
  description?: ReactNode;
  /** The shown-once line. Override only to say something truer. */
  warning?: string;
  closeLabel?: string;
  /** Called once the panel may actually close — after the confirm, if there was one. */
  onClose: () => void;
  /** What to do with it next — a curl for this key and domain. */
  children?: ReactNode;
  className?: string;
}) {
  const { copied, copy } = useCopyToClipboard();
  const [everCopied, setEverCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);

  return (
    <Card className={cn("flex flex-col gap-4 p-6", className)}>
      <div>
        <p className="type-title text-lg text-foreground">{title}</p>
        {description ? <p className="type-body mt-1 text-foreground-soft">{description}</p> : null}
      </div>

      <div className="flex flex-col gap-2">
        <CopyField value={value} label={label} />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="md"
            onClick={async () => {
              if (await copy(value)) setEverCopied(true);
            }}
          >
            {copied ? `Copied the ${label}` : `Copy the ${label}`}
          </Button>
          <p className="type-body-sm font-semibold text-warning">{warning}</p>
        </div>
      </div>

      {children}

      <div className="flex justify-end">
        <Button
          variant="secondary"
          size="md"
          onClick={() => (everCopied ? onClose() : setConfirming(true))}
        >
          {closeLabel}
        </Button>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        tone="destructive"
        title={`Close without copying the ${label}?`}
        consequence={`It isn’t shown again. You’d have to create a new ${label} and swap it in.`}
        confirmLabel="Close anyway"
        cancelLabel="Go back"
        onConfirm={() => {
          setConfirming(false);
          onClose();
        }}
      />
    </Card>
  );
}
