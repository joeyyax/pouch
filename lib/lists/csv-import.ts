/**
 * Turns an uploaded CSV into the rows `lib/lists/import.ts` accepts. The round trip with
 * `GET /v1/lists/:id/export`'s own header is deliberate: `address` and `confirmed_by`-adjacent
 * columns from an export are harmless extra columns here (only `address`, `confirmed` and
 * unrecognized columns matter — the rest become attributes and just ride along unused), so
 * re-uploading a file you just exported works without editing it first.
 */
import { ApiError } from "@/lib/api/errors";
import type { ImportRow, ImportRowError } from "./import";
import { parseCsvRows } from "./csv-parse";

const RESERVED_COLUMNS = new Set(["address", "confirmed"]);
const TRUE_VALUES = new Set(["true", "1", "yes"]);

export interface CsvImportRows {
  rows: ImportRow[];
  /** Structural row problems — wrong column count, no address — caught before addMembership runs. */
  errors: ImportRowError[];
}

/** Parses CSV text into import rows. Throws only for a file with no usable header. */
export function parseMemberCsv(text: string): CsvImportRows {
  const table = parseCsvRows(text).filter((row) => !(row.length === 1 && row[0]?.trim() === ""));
  const header = table[0];
  if (!header) {
    throw new ApiError("validation_failed", "The file is empty.");
  }

  const normalized = header.map((name) => name.trim().toLowerCase());
  const addressIndex = normalized.indexOf("address");
  if (addressIndex === -1) {
    throw new ApiError("validation_failed", 'The file has no "address" column.');
  }
  const confirmedIndex = normalized.indexOf("confirmed");
  const attributeColumns = normalized
    .map((name, index) => ({ name, index }))
    .filter(({ name }) => name.length > 0 && !RESERVED_COLUMNS.has(name));

  const rows: ImportRow[] = [];
  const errors: ImportRowError[] = [];

  for (let i = 1; i < table.length; i++) {
    const line = i + 1; // 1-based, header is line 1
    const cells = table[i];
    if (!cells) continue;

    if (cells.length !== header.length) {
      errors.push({
        line,
        address: cells[addressIndex]?.trim() ?? "",
        message: `Expected ${header.length} columns, found ${cells.length}.`,
      });
      continue;
    }

    const address = cells[addressIndex]?.trim() ?? "";
    if (!address) {
      errors.push({ line, address: "", message: "Address is required." });
      continue;
    }

    const attributes: Record<string, string> = {};
    for (const { name, index } of attributeColumns) {
      const value = cells[index]?.trim();
      if (value) attributes[name] = value;
    }

    rows.push({
      address,
      attributes,
      confirmed: confirmedIndex === -1 ? undefined : TRUE_VALUES.has((cells[confirmedIndex] ?? "").trim().toLowerCase()),
      line,
    });
  }

  return { rows, errors };
}
