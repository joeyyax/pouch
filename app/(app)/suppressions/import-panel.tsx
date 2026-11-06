"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field, fieldClasses } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { REASON_LABEL } from "@/lib/dashboard/views/suppressions";
import type { SuppressionImportSummary } from "@/lib/dashboard/views/suppressions";
import type { SuppressionReason } from "@/lib/db/schema";
import { formatNumber } from "@/lib/format/number";

const REASONS = Object.keys(REASON_LABEL) as SuppressionReason[];

const inputClass = `${fieldClasses({ shape: "compact", size: "md" })} w-full`;

function count(n: number): string {
  return formatNumber(n);
}

export function ImportPanel({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const id = useId();
  const [file, setFile] = useState<File | null>(null);
  const [reason, setReason] = useState<SuppressionReason>("manual");
  const [source, setSource] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SuppressionImportSummary | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    setPending(true);
    setError(null);
    try {
      const query = new URLSearchParams({ reason });
      if (source.trim()) query.set("source", source.trim());
      const response = await fetch(`/api/dashboard/suppressions/import?${query}`, {
        method: "POST",
        headers: { "content-type": "text/csv" },
        body: file,
      });
      const body = (await response.json().catch(() => null)) as
        | SuppressionImportSummary
        | { error?: { message?: string } }
        | null;
      if (!response.ok || !body || !("added" in body)) {
        setError((body && "error" in body && body.error?.message) || "The file couldn't be imported.");
        return;
      }
      setResult(body);
      router.refresh();
    } catch {
      setError("The file couldn't be imported.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onDone()}
      title="Import suppressions"
      description="A CSV of addresses that should never receive mail from this organization."
      footer={
        result ? (
          <Button type="button" size="md" onClick={onDone}>
            Done
          </Button>
        ) : (
          <>
            <Button type="button" variant="secondary" size="md" onClick={onDone}>
              Cancel
            </Button>
            <Button type="submit" form={`${id}-form`} size="md" loading={pending} disabled={!file}>
              Import file
            </Button>
          </>
        )
      }
    >
      {result ? (
        <ImportResult result={result} />
      ) : (
        <form id={`${id}-form`} onSubmit={submit} className="flex flex-col gap-5">
          <div className="flex flex-col gap-4">
            <Field
              id={`${id}-file`}
              label="CSV file"
              hint="An address or email column. Reason and detail columns are used when present."
              error={error ?? undefined}
            >
              <input
                id={`${id}-file`}
                type="file"
                accept=".csv,text/csv"
                required
                className={`${inputClass} file:mr-3 file:rounded-full file:border-0 file:bg-muted file:px-3 file:py-1 file:text-sm file:font-semibold file:text-foreground`}
                onChange={(event) => {
                  setFile(event.currentTarget.files?.[0] ?? null);
                  setError(null);
                }}
              />
            </Field>

            <Field id={`${id}-reason`} label="Reason" hint="For rows without one.">
              <select
                id={`${id}-reason`}
                value={reason}
                onChange={(event) => setReason(event.currentTarget.value as SuppressionReason)}
                className={inputClass}
              >
                {REASONS.map((value) => (
                  <option key={value} value={value}>
                    {REASON_LABEL[value]}
                  </option>
                ))}
              </select>
            </Field>

            <Field id={`${id}-source`} label="Source" hint="Where the list came from. Shown in the From column.">
              <input
                id={`${id}-source`}
                type="text"
                value={source}
                maxLength={100}
                onChange={(event) => setSource(event.currentTarget.value)}
                placeholder="Postmark"
                autoComplete="off"
                className={inputClass}
              />
            </Field>
          </div>
        </form>
      )}
    </Modal>
  );
}

function Tally({ n, label, warn = false }: { n: number; label: string; warn?: boolean }) {
  return (
    <span className={n === 0 ? "text-muted-foreground" : warn ? "text-warning" : undefined}>
      {count(n)} {label}
    </span>
  );
}

function ImportResult({ result }: { result: SuppressionImportSummary }) {
  const [showInvalid, setShowInvalid] = useState(false);
  const listId = useId();

  return (
    <div role="status" className="flex flex-col gap-2 rounded-2xl bg-muted px-4 py-3">
      <p className="type-body-sm text-foreground">
        <Tally n={result.added} label="added" /> · <Tally n={result.already_present} label="already present" /> ·{" "}
        <Tally n={result.invalid} label="invalid" warn />
      </p>
      {result.invalid > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={showInvalid}
            aria-controls={listId}
            onClick={() => setShowInvalid((value) => !value)}
            className="self-start text-sm font-semibold text-foreground underline underline-offset-4"
          >
            {showInvalid ? "Hide invalid rows" : `Show ${result.invalid === 1 ? "the invalid row" : `${count(result.invalid)} invalid rows`}`}
          </button>
          {showInvalid ? (
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
