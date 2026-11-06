"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Icon, type IconName } from "@/components/ui/icon";
import { PopoverContent, PopoverRoot, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { exportFilename } from "@/lib/wire";

// Exports what's on screen: small files download directly, large ones queue and poll while the popover is open.

const POLL_MS = 4000;

type RowStatus = "idle" | "working" | "queued" | "ready" | "error";

interface SerializedExport {
  id: string;
  status: "requested" | "running" | "ready" | "failed" | "expired";
  filename: string | null;
  download_url: string | null;
  error: string | null;
}

function filenameFromDisposition(header: string | null, fallback: string): string {
  const match = header ? /filename="([^"]+)"/.exec(header) : null;
  return match?.[1] ?? fallback;
}

function rowIcon(status: RowStatus): { name: IconName; className: string } {
  switch (status) {
    case "working":
    case "queued":
      return { name: "clock", className: "text-muted-foreground" };
    case "ready":
      return { name: "check", className: "text-success" };
    case "error":
      return { name: "warning", className: "text-danger" };
    default:
      return { name: "file", className: "text-muted-foreground" };
  }
}

function ExportRow({
  title,
  href,
  size,
  fallbackFilename,
}: {
  title: string;
  href: string;
  size?: string;
  fallbackFilename: string;
}) {
  const [status, setStatus] = useState<RowStatus>("idle");
  const [note, setNote] = useState<string | null>(null);
  const [download, setDownload] = useState<{ url: string; filename: string } | null>(null);
  // Polls from state, not a timer handle, so a remount resumes it.
  const [pollId, setPollId] = useState<string | null>(null);

  useEffect(() => {
    if (!pollId) return;
    let cancelled = false;

    async function poll(): Promise<void> {
      try {
        const response = await fetch(`/api/dashboard/exports/${pollId}`);
        if (cancelled) return;
        if (!response.ok) {
          setStatus("error");
          setNote("Couldn't check this export's status. Try again.");
          setPollId(null);
          return;
        }
        const record = (await response.json()) as SerializedExport;
        if (cancelled) return;
        if (record.status === "requested" || record.status === "running") return; // interval below retries
        if (record.status === "ready" && record.download_url) {
          setStatus("ready");
          setDownload({ url: record.download_url, filename: record.filename ?? fallbackFilename });
        } else if (record.status === "expired") {
          setStatus("error");
          setNote("This export expired before it was downloaded. Request it again.");
        } else {
          setStatus("error");
          setNote(record.error ?? "This export failed to build. Request it again.");
        }
        setPollId(null);
      } catch {
        if (!cancelled) {
          setStatus("error");
          setNote("Couldn't check this export's status. Try again.");
          setPollId(null);
        }
      }
    }

    void poll();
    const interval = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pollId, fallbackFilename]);

  async function run(): Promise<void> {
    setStatus("working");
    setNote(null);
    setDownload(null);
    try {
      const response = await fetch(href);

      if (response.status === 202) {
        const record = (await response.json()) as SerializedExport;
        setStatus("queued");
        setNote("Too large to download directly. It's queued and appears here when ready.");
        setPollId(record.id);
        return;
      }

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setStatus("error");
        setNote(body?.error?.message ?? "This export failed to build.");
        return;
      }

      const blob = await response.blob();
      const filename = filenameFromDisposition(response.headers.get("content-disposition"), fallbackFilename);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setStatus("idle");
    } catch {
      setStatus("error");
      setNote("This export failed to build.");
    }
  }

  const icon = rowIcon(status);
  const busy = status === "working" || status === "queued";

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        title={title}
        className={cn(
          "press group flex items-center justify-between gap-3 rounded-2xl bg-muted px-4 py-3 text-left transition-colors hover:bg-secondary disabled:cursor-not-allowed",
        )}
      >
        <span className="flex min-w-0 items-center gap-3">
          {busy ? (
            <span
              aria-hidden
              className="size-5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent text-muted-foreground"
            />
          ) : (
            <Icon name={icon.name} strokeWidth={2} className={cn("size-5 shrink-0", icon.className)} />
          )}
          <span className="truncate text-15 font-medium text-foreground">{title}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {size ? <span className="text-sm text-muted-foreground">{size}</span> : null}
          <Icon
            name="chevron"
            strokeWidth={2.25}
            className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
          />
        </span>
      </button>
      {note ? <p className="px-1 text-sm text-muted-foreground">{note}</p> : null}
      {download ? (
        <a
          href={download.url}
          download={download.filename}
          className="press flex items-center justify-between gap-3 rounded-2xl bg-success/10 px-4 py-3 text-left text-success transition-colors hover:bg-success/15"
        >
          <span className="flex min-w-0 items-center gap-3">
            <Icon name="check" strokeWidth={2} className="size-5 shrink-0" />
            <span className="truncate text-15 font-medium">Ready — download {download.filename}</span>
          </span>
        </a>
      ) : null}
    </div>
  );
}

export function ExportMenu() {
  const params = useSearchParams();
  const query = params.toString();
  const withFormat = (format?: string) => {
    const next = new URLSearchParams(query);
    if (format) next.set("format", format);
    const search = next.toString();
    return search ? `?${search}` : "";
  };

  const stamp = new Date().toISOString().slice(0, 10);

  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="md">
          Export
        </Button>
      </PopoverTrigger>
      <PopoverContent label="Export the current filter" className="w-96" align="end">
        <p className="type-body-sm mb-3 text-foreground-soft">
          A decrypted copy of the current filter, not a backup. Bodies past retention say why
          they&rsquo;re missing.
        </p>
        <div className="flex flex-col gap-2">
          <ExportRow
            title="Message log"
            href={`/api/dashboard/exports/log${withFormat("csv")}`}
            size=".csv"
            fallbackFilename={exportFilename("messages", stamp, "csv")}
          />
          <ExportRow
            title="Message log, full fidelity"
            href={`/api/dashboard/exports/log${withFormat("ndjson")}`}
            size=".ndjson"
            fallbackFilename={exportFilename("messages", stamp, "ndjson")}
          />
          <ExportRow
            title="Bodies and attachments"
            href={`/api/dashboard/exports/bodies${withFormat()}`}
            size=".zip"
            fallbackFilename={exportFilename("bodies", stamp, "zip")}
          />
          <ExportRow
            title="Suppressions and domains"
            href="/api/dashboard/exports/data"
            size=".ndjson"
            fallbackFilename={exportFilename("data", stamp, "ndjson")}
          />
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}
