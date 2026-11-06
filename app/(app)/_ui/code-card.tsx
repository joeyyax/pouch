"use client";

import type { ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

/** Source code in the terminal's dark frame, without its prompt. Copy takes `code`. */
export function CodeCard({ code, children, className }: { code: string; children: ReactNode; className?: string }) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className={cn("dark squircle overflow-hidden rounded-2xl bg-background text-foreground", className)}>
      <div className="flex items-center justify-end border-b border-border px-4 py-3">
        <IconButton
          icon={copied ? "check" : "copy"}
          label={copied ? "Code copied" : "Copy code"}
          variant="bare"
          size="xs"
          onClick={() => copy(code)}
          className="text-muted-foreground hover:text-foreground"
          iconClassName={cn("size-3.5", copied && "text-success-ink")}
        />
      </div>
      <pre
        tabIndex={0}
        className="overflow-x-auto px-4 py-4 font-mono text-sm leading-relaxed focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        {children}
      </pre>
    </div>
  );
}
