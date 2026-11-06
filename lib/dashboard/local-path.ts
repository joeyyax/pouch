/** `value` when it's a path on this site, such as `/domains/dom_1?tab=dns`, else null. Guards redirects built from a URL. */
export function localPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512 || !value.startsWith("/") || value.startsWith("//")) return null;
  if (/[\\\u0000-\u001f]/.test(value)) return null;
  const base = "http://local.invalid";
  try {
    const url = new URL(value, base);
    return url.origin === base ? `${url.pathname}${url.search}${url.hash}` : null;
  } catch {
    return null;
  }
}
