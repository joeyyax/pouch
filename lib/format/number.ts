/** Numbers in one locale, so a server render and the client that hydrates it print the same digits. */

const COUNT = new Intl.NumberFormat("en-US");

/** `1,234`. */
export function formatNumber(value: number): string {
  return COUNT.format(value);
}

const ORDINAL_WORDS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

/** `first` to `tenth` in words, then `11th`, `22nd`, `1,003rd`. */
export function formatOrdinal(value: number): string {
  const word = ORDINAL_WORDS[value - 1];
  if (word) return word;
  const tens = value % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[value % 10] ?? "th";
  return `${formatNumber(value)}${suffix}`;
}
