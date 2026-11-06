"use client";

import type { ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

// A real terminal window for command snippets ("git clone…") — showing the
// actual command reads more credibly than prose here. Forces the dark room
// via the `.dark` class trick (same as Section's tone="dark") so it stays a
// terminal regardless of the page's own light/dark setting.
export function Terminal({
  command,
  children,
  output,
  className,
}: {
  command: string;
  /** The command as rendered, such as highlighted. Defaults to `command`; copy always takes `command`. */
  children?: ReactNode;
  output?: string[];
  className?: string;
}) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className={cn("dark squircle overflow-hidden rounded-2xl bg-background text-foreground", className)}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div aria-hidden className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-danger" />
          <span className="size-2.5 rounded-full bg-warning" />
          <span className="size-2.5 rounded-full bg-success-ink" />
        </div>
        {/* The label carries the result, because the only other feedback is
            an icon swap. Without this a screen reader gets no confirmation
            that the copy happened. */}
        <IconButton
          icon={copied ? "check" : "copy"}
          label={copied ? "Command copied" : "Copy command"}
          variant="bare"
          size="xs"
          onClick={() => copy(command)}
          className="text-muted-foreground hover:text-foreground"
          iconClassName={cn("size-3.5", copied && "text-success-ink")}
        />
      </div>
      {/* pre/code, not paragraphs — assistive tech reads a <p> as prose and
          speech synthesis mangles flags and paths.

          tabIndex because this scrolls: a long command runs past the right
          edge, and a scrollable box that can't take focus puts that overflow
          out of reach for anyone not using a pointer. */}
      <pre
        tabIndex={0}
        className="overflow-x-auto px-4 py-4 font-mono text-sm leading-relaxed focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <code className="whitespace-pre text-foreground">
          <span aria-hidden className="text-primary-strong">
            ${" "}
          </span>
          {children ?? command}
        </code>
        {output?.map((line, i) => (
          <span key={i} className="mt-1 block whitespace-pre text-muted-foreground">
            {line}
          </span>
        ))}
      </pre>
    </div>
  );
}
