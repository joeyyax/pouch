/** Leading characters a spreadsheet reads as a formula. */
export const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * RFC 4180 field quoting: quote only when the value needs it, double any embedded quote. A string
 * a spreadsheet would run as a formula gets a leading `'`, which the importer strips.
 */
export function csvField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  const text = typeof value === "string" && FORMULA_PREFIX.test(raw) ? `'${raw}` : raw;
  if (/[",\n\r\t]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function csvRow(values: (string | number | boolean | null | undefined)[]): string {
  return values.map(csvField).join(",") + "\r\n";
}
