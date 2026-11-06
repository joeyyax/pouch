"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { formatNumber } from "@/lib/format/number";

export interface MemberImportResult {
  added: number;
  already_present: number;
  invalid: number;
  errors: { line: number | null; address: string; message: string }[];
}

/** Picks a CSV and posts it straight away. The result shows above the member list. Render `input` once; `choose` opens the picker. */
export function useMemberImport(listId: string, onResult: (result: MemberImportResult) => void) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);

  async function upload(file: File) {
    setPending(true);
    try {
      const response = await fetch(`/api/dashboard/lists/${listId}/import`, {
        method: "POST",
        headers: { "content-type": "text/csv" },
        body: file,
      });
      const body = (await response.json().catch(() => null)) as
        | MemberImportResult
        | { error?: { message?: string } }
        | null;
      if (!response.ok || !body || !("added" in body)) {
        toast({ title: (body && "error" in body && body.error?.message) || "The file couldn't be imported.", variant: "error" });
        return;
      }
      onResult(body);
      router.refresh();
    } catch {
      toast({ title: "The file couldn't be imported.", variant: "error" });
    } finally {
      setPending(false);
      // Cleared after the upload so choosing the same file again fires a change event.
      if (input.current) input.current.value = "";
    }
  }

  return {
    pending,
    choose: () => input.current?.click(),
    input: (
      <input
        ref={input}
        type="file"
        accept=".csv,text/csv"
        aria-label="CSV of members to import"
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void upload(file);
        }}
      />
    ),
  };
}

export function ImportSummary({ result, onDismiss }: { result: MemberImportResult; onDismiss: () => void }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const invalid = result.invalid;
  const count = (value: number) => formatNumber(value);

  return (
    <div role="status" className="mb-4 flex flex-col gap-2 rounded-2xl bg-muted px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="type-body-sm text-foreground">
          <Tally n={result.added} label="added" /> · <Tally n={result.already_present} label="already present" /> ·{" "}
          <Tally n={invalid} label="invalid" warn />
        </p>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
      {invalid > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((value) => !value)}
            className="self-start text-sm font-semibold text-foreground underline underline-offset-4"
          >
            {open ? "Hide invalid rows" : invalid === 1 ? "Show the invalid row" : `Show ${count(invalid)} invalid rows`}
          </button>
          {open ? (
            <ul id={listId} className="flex max-h-64 flex-col gap-1 overflow-y-auto text-sm">
              {result.errors.map((row, index) => (
                <li key={`${row.line ?? "x"}-${index}`} className="flex min-w-0 flex-wrap gap-x-3">
                  <span className="shrink-0 tabular-nums text-muted-foreground">{row.line ? `Line ${row.line}` : "—"}</span>
                  <span className="min-w-0 truncate font-mono">{row.address || "(blank)"}</span>
                  <span className="min-w-0 text-foreground-soft">{row.message}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Tally({ n, label, warn = false }: { n: number; label: string; warn?: boolean }) {
  return (
    <span className={n === 0 ? "text-muted-foreground" : warn ? "text-warning" : undefined}>
      {formatNumber(n)} {label}
    </span>
  );
}
