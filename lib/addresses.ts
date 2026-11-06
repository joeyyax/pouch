export interface ParsedAddress {
  /** Display name when the input used `Name <address>` form. */
  name: string | null;
  /** Address with the domain part lowercased and the local part preserved. */
  address: string;
}

const ANGLE_FORM = /^\s*(.*?)\s*<\s*([^<>]+)\s*>\s*$/;

/** Lowercases the domain part and preserves the local part. */
export function normalizeAddress(address: string): string {
  const trimmed = address.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return trimmed;
  return `${trimmed.slice(0, at)}@${trimmed.slice(at + 1).toLowerCase()}`;
}

/** Splits `Name <address>` or a bare address into its parts, normalizing the address. */
export function parseAddress(input: string): ParsedAddress | null {
  const match = ANGLE_FORM.exec(input);
  const raw = match ? (match[2] ?? "") : input;
  const address = normalizeAddress(raw);
  if (!isEmailAddress(address)) return null;

  const rawName = match?.[1]?.trim().replace(/^"(.*)"$/, "$1") ?? "";
  return { name: rawName.length > 0 ? rawName : null, address };
}

export function domainOf(address: string): string {
  return normalizeAddress(address).split("@")[1] ?? "";
}

export function formatAddress(parsed: ParsedAddress): string {
  return parsed.name ? `${parsed.name} <${parsed.address}>` : parsed.address;
}

const EMAIL = /^[^\s@,<>"]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function isEmailAddress(address: string): boolean {
  return address.length <= 320 && EMAIL.test(address);
}
