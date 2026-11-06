/**
 * Suppression CSV, both directions. The export's header reads back in unchanged, and the
 * importer also takes the column names and reason words other providers' exports use.
 */
import { and, asc, eq, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { suppressions, type SuppressionReason } from "@/lib/db/schema";
import { ApiError } from "@/lib/api/errors";
import { csvRow } from "@/lib/exports/csv";
import { parseCsvRows } from "@/lib/lists/csv-parse";
import type { SuppressionImportError, SuppressionImportRow } from "./suppression";
import { keysetAfter } from "@/lib/db/keyset";

export const SUPPRESSION_CSV_HEADER = ["address", "reason", "detail", "source", "created_at"] as const;

const ADDRESS_COLUMNS = ["address", "email", "emailaddress", "recipient"];
const REASON_COLUMNS = ["reason", "suppressionreason", "origin"];
const DETAIL_COLUMNS = ["detail", "description", "error"];
const SOURCE_COLUMNS = ["source"];

// Keys are lowercased with everything but letters removed.
const REASON_WORDS: Record<string, SuppressionReason> = {
  hardbounce: "hard_bounce",
  bounce: "hard_bounce",
  bounced: "hard_bounce",
  complaint: "complaint",
  complained: "complaint",
  spamcomplaint: "complaint",
  spamreport: "complaint",
  manual: "manual",
  manualsuppression: "manual",
};

function columnKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, "");
}

function findColumn(header: string[], names: string[]): number {
  return header.findIndex((name) => names.includes(name));
}

/** Maps a reason cell to ours. Undefined when the cell is empty or isn't a reason we know. */
export function reasonFromCell(cell: string): SuppressionReason | undefined {
  return REASON_WORDS[columnKey(cell)];
}

/** Throws only for a file with no header or no address column. */
export function parseSuppressionCsv(text: string): { rows: SuppressionImportRow[]; errors: SuppressionImportError[] } {
  const table = parseCsvRows(text.replace(/^\uFEFF/, ""));
  const blank = (row: string[] | undefined) => !row || row.every((cell) => cell.trim() === "");
  const header = blank(table[0]) ? undefined : table[0]?.map(columnKey);
  if (!header) throw new ApiError("validation_failed", "The file is empty.");

  const addressIndex = findColumn(header, ADDRESS_COLUMNS);
  if (addressIndex === -1) {
    throw new ApiError("validation_failed", 'The file has no "address" or "email" column.');
  }
  const reasonIndex = findColumn(header, REASON_COLUMNS);
  const detailIndex = findColumn(header, DETAIL_COLUMNS);
  const sourceIndex = findColumn(header, SOURCE_COLUMNS);

  const rows: SuppressionImportRow[] = [];
  const errors: SuppressionImportError[] = [];

  for (let i = 1; i < table.length; i++) {
    const cells = table[i] ?? [];
    if (blank(cells)) continue;
    const line = i + 1;
    const address = cells[addressIndex]?.trim() ?? "";
    if (!address) {
      errors.push({ line, address: "", message: "Address is required." });
      continue;
    }
    // A reason cell we don't recognize, such as a bounce message, becomes the detail.
    const reasonCell = reasonIndex === -1 ? "" : (cells[reasonIndex]?.trim() ?? "");
    const reason = reasonFromCell(reasonCell);
    const detail = (detailIndex === -1 ? "" : (cells[detailIndex]?.trim() ?? "")) || (reason ? "" : reasonCell);
    rows.push({
      address,
      reason,
      detail: detail || null,
      source: sourceIndex === -1 ? null : cells[sourceIndex],
      line,
    });
  }

  return { rows, errors };
}

const EXPORT_BATCH = 1000;

/** The organization's list as CSV, oldest first, narrowed by `where` when given. */
export async function* suppressionCsvLines(organizationId: string, where?: SQL): AsyncGenerator<string> {
  yield csvRow([...SUPPRESSION_CSV_HEADER]);
  let after: string | null = null;

  for (;;) {
    const rows: (typeof suppressions.$inferSelect)[] = await db
      .select()
      .from(suppressions)
      .where(
        and(
          eq(suppressions.organizationId, organizationId),
          where,
          after ? keysetAfter({ table: suppressions, sort: suppressions.createdAt, id: suppressions.id }, after) : undefined,
        ),
      )
      .orderBy(asc(suppressions.createdAt), asc(suppressions.id))
      .limit(EXPORT_BATCH);

    for (const row of rows) {
      yield csvRow([row.address, row.reason, row.detail, row.source, row.createdAt.toISOString()]);
    }
    const last = rows[rows.length - 1];
    if (!last || rows.length < EXPORT_BATCH) return;
    after = last.id;
  }
}
