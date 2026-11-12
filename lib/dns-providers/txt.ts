/** A TXT value as text: `"a" "b"` becomes `ab`. A value with no quotes comes back unchanged. */
export function txtText(value: string): string {
  const trimmed = value.trim();
  if (!/^"(?:[^"\\]|\\.)*"(?:\s+"(?:[^"\\]|\\.)*")*$/.test(trimmed)) return value;
  return [...trimmed.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(([, chunk]) => chunk!.replace(/\\(.)/g, "$1")).join("");
}
