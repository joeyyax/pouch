/**
 * Minimal RFC 4180 parser — quoted fields, `""` as an escaped quote inside one, CRLF or LF row
 * endings. Shares only the formula prefix with `lib/exports/csv.ts`'s writer, so a guarded cell
 * reads back as it was.
 */
import { FORMULA_PREFIX } from "@/lib/exports/csv";

/** Removes the `'` lib/exports/csv.ts puts before a cell that would read as a formula. */
function unguard(field: string): string {
  return field.startsWith("'") && FORMULA_PREFIX.test(field.slice(1)) ? field.slice(1) : field;
}

export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const push = () => {
    row.push(unguard(field));
    field = "";
  };
  const endRow = () => {
    push();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      push();
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // A final row with no trailing newline still counts, but a bare trailing newline shouldn't
  // produce a phantom empty row.
  if (field.length > 0 || row.length > 0) endRow();

  return rows;
}
